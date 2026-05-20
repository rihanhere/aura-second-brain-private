import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { env } from "../config/env.js";
import {
  buildRollingSemanticFrame,
  chunkReplyForStreaming,
  createLiveTranscriptWindow,
  pushPartialTranscript,
  scoreEndpointConfidence,
  type EndpointConfidence,
  type EndpointState,
  type LiveTranscriptWindow,
  type RollingSemanticFrame
} from "./streamingSemantic.js";

type ClientEvent =
  | {
      type: "session_start";
      sessionId?: string;
      userId?: string;
      appSessionId?: string;
      appSessionStartedAt?: string;
      newActiveSession?: boolean;
      timezone?: string;
      languagePreference?: "auto" | "en" | "hi" | "hinglish";
      providerKeys?: {
        openRouterKeys?: string;
        groqKey?: string;
        geminiKeys?: string;
      };
    }
  | { type: "partial_transcript"; text: string; sequence?: number }
  | { type: "endpoint_state"; state?: EndpointState; score?: number; reasons?: string[] }
  | { type: "final_transcript"; text: string; requestId?: string; appSessionStartedAt?: string; newActiveSession?: boolean }
  | { type: "cancel"; reason?: string };

type RealtimeSession = {
  clientSessionId: string;
  userId: string;
  appSessionId: string;
  appSessionStartedAt: string;
  newActiveSession: boolean;
  timezone: string;
  languagePreference: "auto" | "en" | "hi" | "hinglish";
  providerKeys: {
    openRouterKeys?: string;
    groqKey?: string;
    geminiKeys?: string;
  };
  window: LiveTranscriptWindow;
  latestEndpoint?: Partial<EndpointConfidence>;
  latestFrame?: RollingSemanticFrame;
  partialTranscriptCount: number;
  semanticRevisionCount: number;
  activeFinalController?: AbortController;
  startedAt: number;
};

const realtimeMetrics = {
  connections: 0,
  activeConnections: 0,
  partialTranscriptCount: 0,
  finalTranscriptCount: 0,
  fallbackCount: 0,
  cancelCount: 0,
  lastFallbackReason: ""
};

export function setupRealtimeConversationServer(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const path = request.url?.split("?")[0] ?? "";
    if (path !== "/realtime/conversation") return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
    realtimeMetrics.connections += 1;
    realtimeMetrics.activeConnections += 1;
    const session = createRealtimeSession(request);
    console.log("[realtime] connected", {
      clientSessionId: session.clientSessionId,
      userId: session.userId,
      appSessionId: session.appSessionId
    });

    send(ws, "semantic_frame", buildAndStoreFrame(session));

    ws.on("message", (data) => {
      void handleClientEvent(ws, session, data).catch((error) => {
        send(ws, "error", {
          message: error instanceof Error ? error.message : "Realtime event failed"
        });
      });
    });

    ws.on("close", () => {
      realtimeMetrics.activeConnections = Math.max(0, realtimeMetrics.activeConnections - 1);
      session.activeFinalController?.abort();
      console.log("[realtime] disconnected", {
        clientSessionId: session.clientSessionId,
        ageMs: Date.now() - session.startedAt
      });
    });
  });

  return wss;
}

export function getRealtimeConversationMetrics() {
  return {
    ...realtimeMetrics,
    flags: {
      streamingStt: env.auraStreamingStt,
      streamingResponse: env.auraStreamingResponse,
      streamingTtsExperimental: env.auraStreamingTtsExperimental,
      predictiveEndpointing: env.auraPredictiveEndpointing
    }
  };
}

async function handleClientEvent(ws: WebSocket, session: RealtimeSession, data: RawData) {
  const event = parseClientEvent(data);
  if (!event) {
    send(ws, "error", { message: "Invalid realtime event" });
    return;
  }

  if (event.type === "session_start") {
    applySessionStart(session, event);
    send(ws, "semantic_frame", buildAndStoreFrame(session));
    return;
  }

  if (event.type === "partial_transcript") {
    if (!env.auraStreamingStt && !env.auraPredictiveEndpointing) return;
    session.partialTranscriptCount += 1;
    realtimeMetrics.partialTranscriptCount += 1;
    session.window = pushPartialTranscript(session.window, event.text);
    send(ws, "semantic_frame", buildAndStoreFrame(session));
    return;
  }

  if (event.type === "endpoint_state") {
    session.latestEndpoint = {
      state: event.state,
      score: typeof event.score === "number" ? event.score : undefined,
      reasons: event.reasons
    };
    send(ws, "semantic_frame", buildAndStoreFrame(session));
    return;
  }

  if (event.type === "cancel") {
    realtimeMetrics.cancelCount += 1;
    session.activeFinalController?.abort();
    send(ws, "fallback", { reason: event.reason ?? "client_cancelled", cancelled: true });
    return;
  }

  if (event.type === "final_transcript") {
    await handleFinalTranscript(ws, session, event.text, event.requestId, {
      appSessionStartedAt: event.appSessionStartedAt,
      newActiveSession: event.newActiveSession
    });
  }
}

async function handleFinalTranscript(
  ws: WebSocket,
  session: RealtimeSession,
  text: string,
  requestId?: string,
  appSession?: { appSessionStartedAt?: string; newActiveSession?: boolean }
) {
  const transcript = text.replace(/\s+/g, " ").trim();
  if (!transcript) {
    sendFallback(ws, "empty_final_transcript");
    return;
  }
  if (!env.auraStreamingResponse) {
    sendFallback(ws, "streaming_response_flag_disabled");
    return;
  }

  session.window = pushPartialTranscript(session.window, transcript);
  session.latestEndpoint = scoreEndpointConfidence(transcript);
  const frame = buildAndStoreFrame(session);
  realtimeMetrics.finalTranscriptCount += 1;
  send(ws, "semantic_frame", frame);
  send(ws, "response_start", {
    requestId,
    safeV1: true,
    intent: frame.intent,
    activeThread: frame.activeThread,
    endpointConfidence: frame.endpoint.score,
    semanticStability: frame.stability.score
  });

  const controller = new AbortController();
  session.activeFinalController?.abort();
  session.activeFinalController = controller;
  const startedAt = Date.now();

  try {
    const result = await callCapturePipeline(session, transcript, controller.signal, appSession);
    if (controller.signal.aborted) return;
    const chunks = chunkReplyForStreaming(result.reply);
    chunks.forEach((chunk, index) => {
      send(ws, "response_delta", {
        requestId,
        index,
        text: chunk,
        safe: true,
        final: index === chunks.length - 1
      });
    });
    send(ws, "response_done", {
      requestId,
      reply: result.reply,
      chunkCount: chunks.length,
      durationMs: Date.now() - startedAt,
      metrics: {
        partialTranscriptCount: session.partialTranscriptCount,
        semanticRevisionCount: session.semanticRevisionCount,
        endpointConfidence: frame.endpoint.score
      },
      capture: {
        memory: result.memory ?? null,
        reminder: result.reminder ?? null,
        reminderDraft: result.reminderDraft ?? null,
        checkInResult: result.checkInResult ?? null
      }
    });
  } catch (error) {
    if (controller.signal.aborted) return;
    const message = error instanceof Error ? error.message : "capture_pipeline_failed";
    sendFallback(ws, message);
  } finally {
    if (session.activeFinalController === controller) session.activeFinalController = undefined;
  }
}

async function callCapturePipeline(
  session: RealtimeSession,
  content: string,
  signal: AbortSignal,
  appSession?: { appSessionStartedAt?: string; newActiveSession?: boolean }
) {
  const host = env.host === "0.0.0.0" || env.host === "::" ? "127.0.0.1" : env.host;
  const response = await fetch(`http://${host}:${env.port}/capture`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-user-id": session.userId,
      "x-aura-app-session-id": session.appSessionId,
      "x-aura-skip-voice": "true",
      ...(session.providerKeys.openRouterKeys?.trim() ? { "x-aura-openrouter-keys": session.providerKeys.openRouterKeys.trim() } : {}),
      ...(session.providerKeys.groqKey?.trim()
        ? {
            "x-aura-groq-key": session.providerKeys.groqKey.trim(),
            "x-aura-groq-keys": session.providerKeys.groqKey.trim()
          }
        : {}),
      ...(session.providerKeys.geminiKeys?.trim() ? { "x-aura-gemini-keys": session.providerKeys.geminiKeys.trim() } : {})
    },
    body: JSON.stringify({
      content,
      inputMode: "voice",
      timezone: session.timezone,
      languagePreference: session.languagePreference,
      appSession: {
        id: session.appSessionId,
        startedAt: appSession?.appSessionStartedAt ?? session.appSessionStartedAt,
        newActiveSession: Boolean(appSession?.newActiveSession ?? session.newActiveSession)
      },
      skipVoice: true
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`capture_${response.status}: ${text.slice(0, 220)}`);
  }

  const data = (await response.json()) as {
    reply?: string;
    memory?: unknown;
    reminder?: unknown;
    reminderDraft?: unknown;
    checkInResult?: unknown;
  };
  if (!data.reply?.trim()) throw new Error("capture_returned_empty_reply");
  return {
    ...data,
    reply: data.reply.trim()
  };
}

function buildAndStoreFrame(session: RealtimeSession) {
  const frame = buildRollingSemanticFrame(session.window, session.latestEndpoint);
  session.latestFrame = frame;
  session.semanticRevisionCount = frame.revisionCount;
  return frame;
}

function createRealtimeSession(request: IncomingMessage): RealtimeSession {
  const userId = headerValue(request, "x-user-id") || "guest-beta-user";
  const appSessionId = headerValue(request, "x-aura-app-session-id") || `realtime-${Date.now()}`;
  const nowIso = new Date().toISOString();
  return {
    clientSessionId: `rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId,
    appSessionId,
    appSessionStartedAt: nowIso,
    newActiveSession: false,
    timezone: "UTC",
    languagePreference: "auto",
    providerKeys: {},
    window: createLiveTranscriptWindow(),
    partialTranscriptCount: 0,
    semanticRevisionCount: 0,
    startedAt: Date.now()
  };
}

function applySessionStart(session: RealtimeSession, event: Extract<ClientEvent, { type: "session_start" }>) {
  session.clientSessionId = cleanId(event.sessionId) || session.clientSessionId;
  session.userId = cleanId(event.userId) || session.userId;
  session.appSessionId = cleanId(event.appSessionId) || session.appSessionId;
  session.appSessionStartedAt = event.appSessionStartedAt?.slice(0, 80) || session.appSessionStartedAt;
  session.newActiveSession = Boolean(event.newActiveSession);
  session.timezone = event.timezone?.slice(0, 80) || session.timezone;
  session.languagePreference = event.languagePreference ?? session.languagePreference;
  session.providerKeys = {
    openRouterKeys: event.providerKeys?.openRouterKeys?.slice(0, 5000),
    groqKey: event.providerKeys?.groqKey?.slice(0, 1200),
    geminiKeys: event.providerKeys?.geminiKeys?.slice(0, 5000)
  };
}

function parseClientEvent(data: RawData): ClientEvent | null {
  try {
    const text = typeof data === "string" ? data : data.toString("utf8");
    const parsed = JSON.parse(text) as Partial<ClientEvent>;
    if (typeof parsed.type !== "string") return null;
    return parsed as ClientEvent;
  } catch {
    return null;
  }
}

function send(ws: WebSocket, type: string, payload: Record<string, unknown>) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, ...payload, sentAt: new Date().toISOString() }));
}

function sendFallback(ws: WebSocket, reason: string) {
  realtimeMetrics.fallbackCount += 1;
  realtimeMetrics.lastFallbackReason = reason;
  send(ws, "fallback", { reason });
}

function headerValue(request: IncomingMessage, key: string) {
  const value = request.headers[key];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function cleanId(value: string | undefined) {
  return value?.replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 160) ?? "";
}
