import { register, unregister, isRegistered } from '@tauri-apps/plugin-global-shortcut';
import { backend } from './backend';
import { useStore } from './store';
import { runTurn, wake, interrupt } from './orchestrator';

let currentKey: string | null = null;
let recording = false;

async function onPress(): Promise<void> {
  const st = useStore.getState();
  const ws = st.activeWorkspace();
  void backend.speakStop();
  if (ws.orchestrator.status === 'thinking' || ws.orchestrator.status === 'speaking') interrupt();
  if (ws.orchestrator.status === 'asleep') wake();
  if (recording) return;
  recording = true;
  st.updateOrch(ws.id, { status: 'listening', liveText: '' });
  try {
    const mics = [st.settings.micDevice, ...(st.settings.micBackups || [])]
      .map((m) => (m || '').trim())
      .filter(Boolean);
    await backend.voiceStart(mics);
  } catch (_e) {
    recording = false;
    st.updateOrch(ws.id, { status: 'awake' });
  }
}

async function onRelease(): Promise<void> {
  if (!recording) return;
  recording = false;
  const st = useStore.getState();
  const wsId = st.activeWorkspaceId;
  st.updateOrch(wsId, { status: 'thinking' });
  try {
    const text = await backend.voiceStop();
    if (text && text.length > 1 && !/^\W+$/.test(text)) {
      st.updateOrch(wsId, { lastUser: text, liveText: '' });
      await runTurn(text);
    } else {
      st.updateOrch(wsId, { status: 'awake', liveText: '', lastReply: 'I did not catch that.' });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    st.updateOrch(wsId, {
      status: 'awake',
      liveText: '',
      lastReply: msg.includes('key missing') ? 'I need a Groq API key. Open settings and paste it in.' : `Voice failed: ${msg.slice(0, 120)}`,
    });
  }
}

export async function bindTalkKey(key: string): Promise<boolean> {
  try {
    if (currentKey && (await isRegistered(currentKey))) {
      await unregister(currentKey);
    }
    await register(key, (event) => {
      if (event.state === 'Pressed') void onPress();
      else if (event.state === 'Released') void onRelease();
    });
    currentKey = key;
    return true;
  } catch (_e) {
    return false;
  }
}

export function isRecording(): boolean {
  return recording;
}

export { onPress as startTalk, onRelease as stopTalk };
