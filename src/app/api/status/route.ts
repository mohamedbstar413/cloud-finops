import { route } from "@/lib/api";
import { aiEnabled, aiModel } from "@/lib/ai/client";

export const GET = route(async () => ({ ai: aiEnabled(), model: aiEnabled() ? aiModel() : null }));
