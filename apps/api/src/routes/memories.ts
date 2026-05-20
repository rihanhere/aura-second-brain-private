import { Router } from "express";
import { z } from "zod";
import { getUserId } from "../middleware/auth.js";
import { listMemories, maybeSummarizeIdleSession, searchMemories } from "../services/memoryStore.js";
import { createEmbedding } from "../services/openRouter.js";
import { providerOverridesFromRequest } from "../services/providerOverrides.js";
import { supabase } from "../config/supabase.js";
import { listProductLearningEvents } from "../services/productLearning.js";
import { getPrivacySettings, updatePrivacySettings } from "../services/privacySettings.js";
import { deleteUserData, exportUserData } from "../services/userDataControls.js";

export const memoriesRouter = Router();

memoriesRouter.get("/", async (req, res, next) => {
  try {
    const memories = await listMemories(getUserId(req));
    res.json({ memories });
  } catch (error) {
    next(error);
  }
});

memoriesRouter.post("/search", async (req, res, next) => {
  try {
    const body = z.object({ query: z.string().min(1), limit: z.number().min(1).max(25).default(10) }).parse(req.body);
    const userId = getUserId(req);

    const embedding = await createEmbedding(body.query, providerOverridesFromRequest(req));
    const memories = await searchMemories(userId, body.query, embedding, body.limit);
    res.json({ memories });
  } catch (error) {
    next(error);
  }
});

memoriesRouter.post("/session/finalize", async (req, res, next) => {
  try {
    const memory = await maybeSummarizeIdleSession(getUserId(req));
    res.json({ ok: true, memory });
  } catch (error) {
    next(error);
  }
});

memoriesRouter.get("/product-learning", async (req, res, next) => {
  try {
    const limit = z.coerce.number().min(1).max(200).default(80).parse(req.query.limit ?? 80);
    const events = await listProductLearningEvents(limit);
    res.json({ events });
  } catch (error) {
    next(error);
  }
});

memoriesRouter.get("/privacy", async (req, res, next) => {
  try {
    const settings = await getPrivacySettings(getUserId(req));
    res.json({ settings });
  } catch (error) {
    next(error);
  }
});

memoriesRouter.patch("/privacy", async (req, res, next) => {
  try {
    const body = z.object({
      privateMode: z.boolean().optional(),
      allowProductImprovement: z.boolean().optional(),
      allowPersonalAdaptation: z.boolean().optional(),
      memoryRetentionDays: z.union([z.literal("forever"), z.number().int().min(1).max(3650)]).optional(),
      disableRawConversationReview: z.boolean().optional()
    }).parse(req.body);
    const settings = await updatePrivacySettings(getUserId(req), body);
    res.json({ settings });
  } catch (error) {
    next(error);
  }
});

memoriesRouter.get("/export", async (req, res, next) => {
  try {
    const data = await exportUserData(getUserId(req));
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

memoriesRouter.delete("/data", async (req, res, next) => {
  try {
    const body = z.object({
      confirm: z.literal("DELETE_MY_AURA_DATA")
    }).parse(req.body ?? {});
    void body;
    const result = await deleteUserData(getUserId(req));
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

memoriesRouter.patch("/:id", async (req, res, next) => {
  try {
    const body = z.object({
      pinned: z.boolean().optional(),
      archived: z.boolean().optional()
    }).parse(req.body);

    if (!supabase) return res.json({ ok: true });

    const memoryLayer = body.archived ? "archived" : body.pinned ? "pinned" : undefined;
    const { data, error } = await supabase
      .from("memories")
      .update(memoryLayer ? { memory_layer: memoryLayer } : {})
      .eq("id", req.params.id)
      .eq("user_id", getUserId(req))
      .select("*")
      .single();

    if (error) throw error;
    res.json({ memory: data });
  } catch (error) {
    next(error);
  }
});
