import type { NextRequest } from "next/server";

export async function createContext(_req: NextRequest) {
  return {
    auth: null,
    session: null,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
