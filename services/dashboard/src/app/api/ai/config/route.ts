import { NextRequest } from 'next/server';
import { forwardAgent } from '@/lib/agent-proxy';

export async function GET(request: NextRequest) {
  const response = await forwardAgent(new NextRequest(new URL('/api/agent/models', request.url)), ['models']);
  if (!response.ok) return response;
  const models = await response.json();
  return Response.json({ enabled: models.chatgpt_connected !== false, provider: 'TINA Agent',
    model: models.chat_model, chatgpt_connected: models.chatgpt_connected, sharedWithTerminal: true });
}
