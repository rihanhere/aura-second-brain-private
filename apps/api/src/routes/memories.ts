import { Router } from "express";
import { z } from "zod";
import { getUserId } from "../middleware/auth.js";
import { listMemories, maybeSummarizeIdleSession, searchMemories } from "../services/memoryStore.js";
import { createEmbedding } from "../services/openRouter.js";
import { providerOverridesFromRequest } from "../services/providerOverrides.js";
import { supabase } from "../config/supabase.js";

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
