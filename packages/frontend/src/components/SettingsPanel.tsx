import { useEffect, useState } from "react";
import type {
  AudioDevice,
  AudioDevicesInfo,
  AudioInputTest,
  CameraInfo,
  CameraSettings,
  CameraTestResult,
} from "@kodama/shared";
import { SettingsShortcuts } from "./SettingsShortcuts.js";
import { SettingsSpeakers } from "./SettingsSpeakers.js";
import { SettingsDictionary } from "./SettingsDictionary.js";

type Tab = "audio" | "camera" | "shortcuts" | "speakers" | "dictionary";

const TABS: { id: Tab; label: string }[] = [
  { id: "audio", label: "デバイス" },
  { id: "camera", label: "カメラ" },
  { id: "shortcuts", label: "ショートカット" },
  { id: "speakers", label: "話者" },
  { id: "dictionary", label: "辞書" },
];

/**
 * 設定画面（オーバーレイ）. タブで機能ごとに分かれる:
 * - デバイス: 音声入出力の切り替えとその場テスト
 * - カメラ: 在室検知の接続設定・接続テスト・映像のライブプレビュー
 * - ショートカット: グローバルショートカットのキー録画（保存即反映）
 * - 話者: 認識済みユーザ（声の登録）の名前変更・削除
 * - 辞書: 発音辞書（読み）・語彙（認識ヒント）・除外リスト（幻覚フィルタ）の編集
 * いずれもバックエンドのREST越しに操作し, 変更はDBへ永続化される.
 */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("audio");

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>設定</h2>
          <button className="settings-close" onClick={onClose} title="閉じる">
            ✕
          </button>
        </div>

        <nav className="settings-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={tab === t.id ? "active" : ""}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {tab === "audio" && <AudioTab />}
        {tab === "camera" && <CameraTab />}
        {tab === "shortcuts" && <SettingsShortcuts />}
        {tab === "speakers" && <SettingsSpeakers />}
        {tab === "dictionary" && <SettingsDictionary />}
      </div>
    </div>
  );
}

/** 音声入出力デバイスの切り替え・テスト（/api/audio/*） */
function AudioTab() {
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

  if (error) return <p className="settings-error">{error}</p>;
  if (!info) return <p className="settings-hint">読み込み中…</p>;

  return (
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
  );
}

/** カメラ（在室検知）の接続設定・テスト・ライブプレビュー（/api/camera*） */
function CameraTab() {
  const [camera, setCamera] = useState<CameraInfo | null>(null);
  const [error, setError] = useState("");
  const [cam, setCam] = useState<CameraSettings>({
    rtspUrl: "",
    host: "",
    user: "",
    pass: "",
  });
  const [camMsg, setCamMsg] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [testingCam, setTestingCam] = useState(false);
  const [savingCam, setSavingCam] = useState(false);
  // プレビューの再接続キー（保存・再試行で <img> を張り直す）と取得失敗フラグ.
  const [previewNonce, setPreviewNonce] = useState(1);
  const [previewErr, setPreviewErr] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/camera")
      .then((r) => r.json())
      .then((c: CameraInfo) => {
        if (!alive) return;
        setCamera(c);
        setCam(c.settings);
      })
      .catch(() => alive && setError("カメラ設定を取得できませんでした（バックエンド未接続）．"));
    return () => {
      alive = false;
    };
  }, []);

  const setCamField = (key: keyof CameraSettings, value: string) => {
    setCam((prev) => ({ ...prev, [key]: value }));
    setCamMsg(null);
  };

  const testCamera = async () => {
    setTestingCam(true);
    setCamMsg(null);
    try {
      const r = (await fetch("/api/camera/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cam),
      }).then((x) => x.json())) as CameraTestResult;
      setCamMsg({ ok: r.ok, text: r.message });
    } catch {
      setCamMsg({ ok: false, text: "接続テストに失敗しました" });
    } finally {
      setTestingCam(false);
    }
  };

  const saveCamera = async () => {
    setSavingCam(true);
    setCamMsg(null);
    try {
      const c = (await fetch("/api/camera", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cam),
      }).then((x) => x.json())) as CameraInfo;
      setCamera(c);
      setCam(c.settings);
      // 新しい接続でプレビューを張り直す.
      setPreviewErr(false);
      setPreviewNonce((n) => n + 1);
      setCamMsg({
        ok: c.running,
        text: c.running
          ? "保存しました．在室検知を再起動しました"
          : "保存しました（接続情報が無いため在室検知は停止中です）",
      });
    } catch {
      setCamMsg({ ok: false, text: "保存に失敗しました" });
    } finally {
      setSavingCam(false);
    }
  };

  if (error) return <p className="settings-error">{error}</p>;
  if (!camera) return <p className="settings-hint">読み込み中…</p>;

  return (
    <section className="settings-row">
      <label>
        カメラ（在室検知） —{" "}
        {camera.running
          ? camera.present
            ? "稼働中・在室"
            : "稼働中・不在"
          : "停止"}
      </label>

      {camera.running && (
        <div className="cam-preview">
          {previewErr ? (
            <div className="cam-preview-fallback">
              <p>映像を取得できませんでした</p>
              <button
                onClick={() => {
                  setPreviewErr(false);
                  setPreviewNonce((n) => n + 1);
                }}
              >
                再接続
              </button>
            </div>
          ) : (
            <img
              key={previewNonce}
              src={`/api/camera/stream?t=${previewNonce}`}
              alt="カメラ映像（リアルタイム）"
              onError={() => setPreviewErr(true)}
            />
          )}
          <p className="settings-hint">リアルタイム映像（在室検知に使用中のカメラ）</p>
        </div>
      )}

      <div className="settings-field">
        <span>RTSP URL</span>
        <input
          type="text"
          value={cam.rtspUrl}
          onChange={(e) => setCamField("rtspUrl", e.target.value)}
          placeholder="rtsp://user:pass@host:554/…（直接指定）"
        />
      </div>
      <p className="settings-hint">
        URL未指定でも，QwatchカメラならホストとID/パスワードから自動解決します．
      </p>
      <div className="settings-field">
        <span>ホスト</span>
        <input
          type="text"
          value={cam.host}
          onChange={(e) => setCamField("host", e.target.value)}
          placeholder="例: 192.168.1.50"
        />
      </div>
      <div className="settings-field">
        <span>ユーザ名</span>
        <input
          type="text"
          value={cam.user}
          onChange={(e) => setCamField("user", e.target.value)}
          placeholder="カメラの管理ユーザ"
        />
      </div>
      <div className="settings-field">
        <span>パスワード</span>
        <input
          type="password"
          value={cam.pass}
          onChange={(e) => setCamField("pass", e.target.value)}
        />
      </div>
      <div className="settings-control">
        <button onClick={testCamera} disabled={testingCam || savingCam}>
          {testingCam ? "接続確認中…" : "接続テスト"}
        </button>
        <button onClick={saveCamera} disabled={testingCam || savingCam}>
          {savingCam ? "適用中…" : "保存して再接続"}
        </button>
      </div>
      {camMsg && (
        <p className={`settings-result ${camMsg.ok ? "ok" : "ng"}`}>
          {camMsg.text}
        </p>
      )}
    </section>
  );
}
