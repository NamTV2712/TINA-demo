import { NextRequest } from 'next/server';
import { forwardAgent } from '@/lib/agent-proxy';

export const dynamic = 'force-dynamic';
async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return forwardAgent(request, (await context.params).path);
}
export { forward as GET, forward as POST, forward as PUT, forward as PATCH, forward as DELETE };
