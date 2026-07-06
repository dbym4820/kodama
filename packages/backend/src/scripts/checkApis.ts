/**
 * Phase 0 の受け入れテスト: Claude / OpenAI 双方の疎通と,
 * ローカルストレージ層が機能するかを確認する.
 *   実行: npm run check:apis
 */
import { config } from "../config.js";
import { ClaudeClient } from "../brain/claudeClient.js";
import { OpenAITts } from "../tts/openaiTts.js";
import { Store } from "../memory/store.js";
import { AssistantState, type MessageRecord } from "@kodama/shared";

async function main() {
  config.requireKeys(); // 鍵が無ければここで明示的に失敗

  console.log("== 谺(kodama) Phase 0 疎通確認 ==\n");

  // 1) ローカルストレージ
  const store = new Store(config.dataDir);
  const session = store.createSession();
  store.addMessage({
    sessionId: session.id,
    role: "system",
    text: "疎通確認セッション",
  });
  console.log(`✓ ローカルDB/ストレージOK  (DATA_DIR=${config.dataDir})`);

  // 2) Claude（頭脳）
  const claude = new ClaudeClient();
  const history: MessageRecord[] = [
    {
      id: "x",
      sessionId: session.id,
      role: "user",
      text: "「準備完了」とだけ短く答えてください．",
      audioPath: null,
      speaker: null,
      createdAt: new Date().toISOString(),
    },
  ];
  const reply = await claude.converse({
    history,
    toolContext: {
      store,
      getPresence: () => false,
      getState: () => AssistantState.IDLE,
    },
  });
  store.addMessage({ sessionId: session.id, role: "assistant", text: reply });
  console.log(`✓ Claude (${config.brainModel}) 応答: ${reply.trim()}`);

  // 3) OpenAI TTS（声）
  const tts = new OpenAITts();
  const audio = await tts.synthesize("これは音声合成の疎通確認です．");
  const path = store.saveAudio(session.id, "assistant", audio);
  console.log(`✓ OpenAI TTS (${config.ttsModel}) 音声 ${audio.length} bytes → ${path}`);

  store.endSession(session.id, "疎通確認完了");
  store.close();

  console.log(`\n状態機械の初期状態: ${AssistantState.IDLE}`);
  console.log("\nすべて成功しました．Phase 1（音声往復ループ）へ進めます．");
}

main().catch((err) => {
  console.error("\n✗ 疎通確認に失敗しました:\n", err.message ?? err);
  process.exit(1);
});
