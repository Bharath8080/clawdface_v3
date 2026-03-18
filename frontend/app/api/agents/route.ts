import { NextResponse } from 'next/server';
import { db, agents } from '@/drizzle';
import { eq } from 'drizzle-orm';

// Helper to generate unique timestamped emails
function generateAgentEmail(name: string): string {
  const cleanName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const now = new Date();
  const timestamp = now.toISOString()
    .slice(0, 16) // YYYY-MM-DDTHH:mm
    .replace(/:/g, '')
    .replace('T', '-');
  const randomSuffix = Math.random().toString(36).substring(2, 6);
  return `${cleanName}-${timestamp}-${randomSuffix}@clawdface.ai`;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, avatarId, openclawUrl, gatewayToken, agentType, config, botId } = body;

    if (!name || !avatarId || !openclawUrl || !gatewayToken) {
      return NextResponse.json(
        { error: 'Missing required fields: name, avatarId, openclawUrl, gatewayToken' },
        { status: 400 }
      );
    }

    const email = generateAgentEmail(name);

    // Create new agent with link to the bot library
    const [newAgent] = await db
      .insert(agents)
      .values({
        email,
        name,
        avatar_id: avatarId,
        openclaw_url: openclawUrl,
        gateway_token: gatewayToken,
        agent_type: agentType || 'openclaw',
        config: config || {},
        bot_id: botId || null,
      })
      .returning();

    return NextResponse.json(
      {
        id: newAgent.id,
        email: newAgent.email,
        name: newAgent.name,
        avatarId: newAgent.avatar_id,
        openclawUrl: newAgent.openclaw_url,
        gatewayToken: newAgent.gateway_token,
        agentType: newAgent.agent_type,
        config: newAgent.config,
        botId: newAgent.bot_id,
        created_at: newAgent.created_at,
      },
      { status: 201 }
    );
  } catch (error: any) {
    console.error('Error creating agent:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
