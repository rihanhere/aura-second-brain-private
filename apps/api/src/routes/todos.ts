import { Router } from "express";
import { z } from "zod";
import { supabase } from "../config/supabase.js";
import { getUserId } from "../middleware/auth.js";

export const todosRouter = Router();
const localTodos: Array<Record<string, unknown>> = [];

todosRouter.get("/", async (req, res, next) => {
  try {
    const userId = getUserId(req);
    if (!supabase) return res.json({ todos: localTodos.filter((todo) => todo.user_id === userId) });

    const { data, error } = await supabase.from("todos").select("*").eq("user_id", userId).order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ todos: data });
  } catch (error) {
    next(error);
  }
});

todosRouter.post("/", async (req, res, next) => {
  try {
    const body = z.object({
      title: z.string().min(1),
      priority: z.enum(["low", "medium", "high"]).default("medium"),
      dueAt: z.string().datetime().optional()
    }).parse(req.body);
    const userId = getUserId(req);
    const payload = { user_id: userId, title: body.title, priority: body.priority, due_at: body.dueAt, status: "open" };
    const todoResult = supabase ? await supabase.from("todos").insert(payload).select("*").single() : null;
    if (todoResult?.error) throw todoResult.error;

    const todo = todoResult?.data ?? { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...payload };
    if (!supabase) localTodos.unshift(todo);
    res.status(201).json({ todo });
  } catch (error) {
    next(error);
  }
});

todosRouter.patch("/:id", async (req, res, next) => {
  try {
    const body = z.object({
      title: z.string().min(1).optional(),
      priority: z.enum(["low", "medium", "high"]).optional(),
      status: z.enum(["open", "completed", "archived"]).optional()
    }).parse(req.body);

    if (!supabase) return res.json({ ok: true });
    const { data, error } = await supabase
      .from("todos")
      .update(body)
      .eq("id", req.params.id)
      .eq("user_id", getUserId(req))
      .select("*")
      .single();
    if (error) throw error;
    res.json({ todo: data });
  } catch (error) {
    next(error);
  }
});
