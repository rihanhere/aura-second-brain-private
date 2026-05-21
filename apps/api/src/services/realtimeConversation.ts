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
  lastClientEventType?: string;
  lastServerEventType?: string;
  lastMessageAt: number;
  lastSendAt: number;
  lastPongAt: number;
};

const realtimeMetrics = {
  connections: 0,
  activeConnections: 0,
  partialTranscriptCount: 0,
  finalTranscriptCount: 0,
  fallbackCount: 0,
  cancelCount: 0,
  sendErrorCount: 0,
  heartbeatPingCount: 0,
  heartbeatPongCount: 0,
  heartbeatTerminateCount: 0,
  closeCount: 0,
  errorCount: 0,
  captureTimeoutCount: 0,
  captureSuccessCount: 0,
  captureFailureCount: 0,
  lastFallbackReason: "",
  lastCloseCode: 0,
  lastCloseReason: "",
  lastErrorMessage: "",
  lastClientSessionId: "",
  lastClientEventType: "",
  lastServerEventType: "",
  lastCaptureDurationMs: 0,
  lastCaptureError: "",
  lastConnectedAt: "",
  lastDisconnectedAt: ""
};

export function setupRealtimeConversationServer(server: Server) {
  const wss = new WebSocketServer({ noServer: true });
  const liveness = new WeakMap<WebSocket, { isAlive: boolean; session: RealtimeSession }>();
  const heartbeatMs = Math.max(5_000, env.realtimeHeartbeatMs);

  const heartbeatTimer = setInterval(() => {
    for (const client of wss.clients) {
      const state = liveness.get(client);
      if (!state || client.readyState !== WebSocket.OPEN) continue;
      if (!state.isAlive) {
        realtimeMetrics.heartbeatTerminateCount += 1;
        console.warn("[realtime] heartbeat_stale_terminate", {
          clientSessionId: state.session.clientSessionId,
          lastMessageAgeMs: Date.now() - state.session.lastMessageAt,
          lastPongAgeMs: Date.now() - state.session.lastPongAt
        });
        client.terminate();
        continue;
      }
      state.isAlive = false;
      realtimeMetrics.heartbeatPingCount += 1;
      try {
        client.ping();
      } catch (error) {
        realtimeMetrics.sendErrorCount += 1;
        console.warn("[realtime] heartbeat_ping_failed", {
          clientSessionId: state.session.clientSessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }, heartbeatMs);
  heartbeatTimer.unref();
  wss.on("close", () => clearInterval(heartbeatTimer));

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
    realtimeMetrics.lastClientSessionId = session.clientSessionId;
    realtimeMetrics.lastConnectedAt = new Date().toISOString();
    liveness.set(ws, { isAlive: true, session });
    console.log("[realtime] connected", {
      clientSessionId: session.clientSessionId,
      userId: session.userId,
      appSessionId: session.appSessionId
    });

    send(ws, "semantic_frame", buildAndStoreFrame(session), session);

    ws.on("message", (data) => {
      void handleClientEvent(ws, session, data).catch((error) => {
        send(ws, "error", {
          message: error instanceof Error ? error.message : "Realtime event failed"
        }, session);
      });
    });

    ws.on("pong", () => {
      const state = liveness.get(ws);
      if (state) state.isAlive = true;
      session.lastPongAt = Date.now();
      realtimeMetrics.heartbeatPongCount += 1;
    });

    ws.on("error", (error) => {
      realtimeMetrics.errorCount += 1;
      realtimeMetrics.lastErrorMessage = error instanceof Error ? error.message : String(error);
      console.warn("[realtime] websocket_error", {
        clientSessionId: session.clientSessionId,
        error: realtimeMetrics.lastErrorMessage
      });
    });

    ws.on("close", (code, reason) => {
      realtimeMetrics.activeConnections = Math.max(0, realtimeMetrics.activeConnections - 1);
      realtimeMetrics.closeCount += 1;
      realtimeMetrics.lastCloseCode = code;
      realtimeMetrics.lastCloseReason = reason.toString();
      realtimeMetrics.lastDisconnectedAt = new Date().toISOString();
      liveness.delete(ws);
      session.activeFinalController?.abort();
      console.log("[realtime] disconnected", {
        clientSessionId: session.clientSessionId,
        ageMs: Date.now() - session.startedAt,
        code,
        reason: reason.toString(),
        lastClientEventType: session.lastClientEventType,
        lastServerEventType: session.lastServerEventType
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
    send(ws, "error", { message: "Invalid realtime event" }, session);
    return;
  }
  session.lastClientEventType = event.type;
  session.lastMessageAt = Date.now();
  realtimeMetrics.lastClientEventType = event.type;

  if (event.type === "session_start") {
    applySessionStart(session, event);
    send(ws, "semantic_frame", buildAndStoreFrame(session), session);
    return;
  }

  if (event.type === "partial_transcript") {
    if (!env.auraStreamingStt && !env.auraPredictiveEndpointing) return;
    session.partialTranscriptCount += 1;
    realtimeMetrics.partialTranscriptCount += 1;
    session.window = pushPartialTranscript(session.window, event.text);
    send(ws, "semantic_frame", buildAndStoreFrame(session), session);
    return;
  }

  if (event.type === "endpoint_state") {
    session.latestEndpoint = {
      state: event.state,
      score: typeof event.score === "number" ? event.score : undefined,
      reasons: event.reasons
    };
    send(ws, "semantic_frame", buildAndStoreFrame(session), session);
    return;
  }

  if (event.type === "cancel") {
    realtimeMetrics.cancelCount += 1;
    session.activeFinalController?.abort();
    send(ws, "fallback", { reason: event.reason ?? "client_cancelled", cancelled: true }, session);
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
    sendFallback(ws, "empty_final_transcript", session);
    return;
  }
  if (!env.auraStreamingResponse) {
    sendFallback(ws, "streaming_response_flag_disabled", session);
    return;
  }

  session.window = pushPartialTranscript(session.window, transcript);
  session.latestEndpoint = scoreEndpointConfidence(transcript);
  const frame = buildAndStoreFrame(session);
  realtimeMetrics.finalTranscriptCount += 1;
  send(ws, "semantic_frame", frame, session);
  send(ws, "response_start", {
    requestId,
    safeV1: true,
    intent: frame.intent,
    activeThread: frame.activeThread,
    endpointConfidence: frame.endpoint.score,
    semanticStability: frame.stability.score
  }, session);

  const controller = new AbortController();
  session.activeFinalController?.abort();
  session.activeFinalController = controller;
  const startedAt = Date.now();
  let timedOut = false;
  const timeoutMs = Math.max(5_000, env.realtimeCaptureTimeoutMs);
  const timeout = setTimeout(() => {
    timedOut = true;
    realtimeMetrics.captureTimeoutCount += 1;
    controller.abort();
  }, timeoutMs);

  try {
    const result = await callCapturePipeline(session, transcript, controller.signal, appSession);
    if (controller.signal.aborted) return;
    realtimeMetrics.captureSuccessCount += 1;
    realtimeMetrics.lastCaptureDurationMs = Date.now() - startedAt;
    const chunks = chunkReplyForStreaming(result.reply);
    chunks.forEach((chunk, index) => {
      send(ws, "response_delta", {
        requestId,
        index,
        text: chunk,
        safe: true,
        final: index === chunks.length - 1
      }, session);
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
    }, session);
  } catch (error) {
    if (controller.signal.aborted && !timedOut) return;
    realtimeMetrics.captureFailureCount += 1;
    realtimeMetrics.lastCaptureDurationMs = Date.now() - startedAt;
    const message = timedOut ? `capture_timeout_${timeoutMs}ms` : error instanceof Error ? error.message : "capture_pipeline_failed";
    realtimeMetrics.lastCaptureError = message;
    sendFallback(ws, message, session);
  } finally {
    clearTimeout(timeout);
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
    startedAt: Date.now(),
    lastMessageAt: Date.now(),
    lastSendAt: 0,
    lastPongAt: Date.now()
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

function send(ws: WebSocket, type: string, payload: Record<string, unknown>, session?: RealtimeSession) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const body = JSON.stringify({ type, ...payload, sentAt: new Date().toISOString() });
  if (session) {
    session.lastServerEventType = type;
    session.lastSendAt = Date.now();
  }
  realtimeMetrics.lastServerEventType = type;
  try {
    ws.send(body, (error) => {
      if (!error) return;
      realtimeMetrics.sendErrorCount += 1;
      console.warn("[realtime] send_failed", {
        clientSessionId: session?.clientSessionId,
        type,
        error: error.message
      });
    });
  } catch (error) {
    realtimeMetrics.sendErrorCount += 1;
    console.warn("[realtime] send_threw", {
      clientSessionId: session?.clientSessionId,
      type,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function sendFallback(ws: WebSocket, reason: string, session?: RealtimeSession) {
  realtimeMetrics.fallbackCount += 1;
  realtimeMetrics.lastFallbackReason = reason;
  send(ws, "fallback", { reason }, session);
}

function headerValue(request: IncomingMessage, key: string) {
  const value = request.headers[key];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function cleanId(value: string | undefined) {
  return value?.replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 160) ?? "";
}
