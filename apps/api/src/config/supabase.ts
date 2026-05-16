import { createClient } from "@supabase/supabase-js";
import { env, hasSupabase } from "./env.js";

export const supabase = hasSupabase
  ? createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: { persistSession: false }
    })
  : null;
