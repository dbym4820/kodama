import { useEffect, useState } from "react";
import type {
  AudioDevice,
  AudioDevicesInfo,
  AudioInputTest,
} from "@kodama/shared";

/**
 * 設定画面（オーバーレイ）. 音声の入出力デバイスを一覧から切り替え,
 * その場でテスト（入力=録音レベル測定 / 出力=テスト音再生）できる.
 * バックエンドのREST（/api/audio/*）越しに操作する.
 */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<AudioDevicesInfo | null>(null);
  const [error, setError] = useState("");
  const [inputIndex, setInputIndex] = useState(0);
  const [outputIndex, setOutputIndex] = useState(-1);
  const [inputResult, setInputResult] = useState<AudioInputTest | null>(null);
  const [testingIn, setTestingIn] = useState(false);
  const [testingOut, setTestingOut] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/audio/devices")
      .then((r) => r.json())
      .then((d: AudioDevicesInfo) => {
        if (!alive) return;
        setInfo(d);
        setInputIndex(d.selected.inputIndex);
        setOutputIndex(d.selected.outputIndex);
      })
      .catch(() => alive && setError("デバイス一覧を取得できませんでした（バックエンド未接続）．"));
    return () => {
      alive = false;
    };
  }, []);

  const changeInput = async (index: number) => {
    setInputIndex(index);
    setInputResult(null);
    await fetch("/api/audio/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index }),
    }).catch(() => {});
  };

  const changeOutput = async (index: number) => {
    setOutputIndex(index);
    await fetch("/api/audio/output", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index }),
    }).catch(() => {});
  };

  const testInput = async () => {
    setTestingIn(true);
    setInputResult(null);
    try {
      const r = (await fetch("/api/audio/test-input", { method: "POST" }).then(
        (x) => x.json(),
      )) as AudioInputTest;
      setInputResult(r);
    } catch {
      setInputResult({ level: 0, ok: false });
    } finally {
      setTestingIn(false);
    }
  };

  const testOutput = async () => {
    setTestingOut(true);
    try {
      await fetch("/api/audio/test-output", { method: "POST" });
    } catch {
      /* 無視 */
    } finally {
      setTestingOut(false);
    }
  };

  const opt = (d: AudioDevice) => (
    <option key={d.index} value={d.index}>
      {d.name}
    </option>
  );

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>設定 — 音声デバイス</h2>
          <button className="settings-close" onClick={onClose} title="閉じる">
            ✕
          </button>
        </div>

        {error && <p className="settings-error">{error}</p>}

        {info && (
          <>
            <section className="settings-row">
              <label>入力（マイク）</label>
              <div className="settings-control">
                <select
                  value={inputIndex}
                  onChange={(e) => changeInput(Number(e.target.value))}
                >
                  {info.input.map(opt)}
                </select>
                <button onClick={testInput} disabled={testingIn}>
                  {testingIn ? "測定中…" : "テスト"}
                </button>
              </div>
              {inputResult && (
                <div className="settings-meter">
                  <div className="meter-track">
                    <div
                      className="meter-fill"
                      style={{ width: `${Math.round(inputResult.level * 100)}%` }}
                    />
                  </div>
                  <span className={inputResult.ok ? "ok" : "ng"}>
                    {inputResult.ok ? "入力を検知しました" : "音声を検知できませんでした"}
                  </span>
                </div>
              )}
              {testingIn && (
                <p className="settings-hint">マイクに向かって話してください…</p>
              )}
            </section>

            <section className="settings-row">
              <label>出力（スピーカー）</label>
              <div className="settings-control">
                <select
                  value={outputIndex}
                  onChange={(e) => changeOutput(Number(e.target.value))}
                >
                  <option value={-1}>システム既定</option>
                  {info.output.map(opt)}
                </select>
                <button onClick={testOutput} disabled={testingOut}>
                  {testingOut ? "再生中…" : "テスト音"}
                </button>
              </div>
              <p className="settings-hint">
                テスト音が聞こえる出力先を選んでください．
              </p>
            </section>
          </>
        )}

        {!info && !error && <p className="settings-hint">読み込み中…</p>}
      </div>
    </div>
  );
}
