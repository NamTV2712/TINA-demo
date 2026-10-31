import { NextRequest } from 'next/server';
import { forwardAgent } from '@/lib/agent-proxy';

// Generic chat uses the current Agent API contract; meeting Q&A uses meeting-knowledge instead.
export async function POST(request: NextRequest) { return forwardAgent(request, ['chat']); }
