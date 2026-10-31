/** NextAuth catch-all handler. Config lives in ./authOptions (an App Router route.ts may only export
 *  HTTP handlers). See authOptions.ts for why NextAuth is only the OAuth broker here. */
import NextAuth from "next-auth";
import { NextResponse, type NextRequest } from "next/server";
import { authOptions } from "./authOptions";

const handler = NextAuth(authOptions);
type RouteContext = { params: Promise<{ nextauth: string[] }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const { nextauth } = await context.params;
  if (nextauth.at(-1) === "providers" && authOptions.providers.length === 0) {
    return NextResponse.json({}, { headers: { "Cache-Control": "no-store" } });
  }
  return handler(request, context);
}

export const POST = handler;
