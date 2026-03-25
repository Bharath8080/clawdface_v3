// Shared utility to generate unique timestamped emails for agents
export function generateAgentEmail(name: string): string {
  const cleanName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const now = new Date();
  const timestamp = now.toISOString()
    .slice(0, 16) // YYYY-MM-DDTHH:mm
    .replace(/:/g, '')
    .replace('T', '-');
  
  // Format: name-timestampclawdfaceai@agent.truhire.ai
  return `${cleanName}-${timestamp}clawdfaceai@agent.truhire.ai`;
}
