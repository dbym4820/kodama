import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { config } from "../config.js";

/**
 * ONNX人物検出（在室検知の補助）.
 *
 * YOLOX-tiny（COCO, onnxruntime-node, 完全ローカル）でRTSPフレームに
 * 人が映っているかを直接判定する. フレーム差分（動き）だけでは静止している人を
 * 「不在」と誤るため, 定期的にこの検出で在室の根拠を補強する（ハイブリッド判定）.
 * 画面端で見切れた人物にも比較的強い（SSD MobileNetでは不十分だったため採用）.
 *
 * モデル未配置・onnxruntime読み込み失敗時は無効化され, 動き検知のみで動作する
 * （他機能を巻き込まない, 話者識別と同じ流儀）.
 */

/** YOLOX-tiny の入力解像度 */
const INPUT_SIZE = 416;
/** COCOクラスの person は先頭（index 0） */
const PERSON_CLASS = 0;
/** YOLOXのletterbox余白色（114,114,114） */
const PAD_COLOR = "0x727272";

interface OrtModule {
  InferenceSession: {
    create(path: string, opts?: unknown): Promise<OrtSession>;
  };
  Tensor: new (
    type: string,
    data: Float32Array,
    dims: number[],
  ) => unknown;
}

interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<
    Record<string, { dims: readonly number[]; data: Float32Array }>
  >;
}

/** 1回の検出結果 */
export interface PersonDetection {
  /** 人物を検出したか */
  found: boolean;
  /** 最高スコア（0〜1, objectness×人物クラス確率の最大） */
  score: number;
}

export class PersonDetector {
  private session: OrtSession | null = null;
  private ort: OrtModule | null = null;
  private inputName = "";
  private outputName = "";

  get available(): boolean {
    return this.session !== null;
  }

  /**
   * onnxruntime-node とモデルを読み込む. 失敗しても例外は投げず無効化に留める.
   */
  async init(): Promise<void> {
    try {
      if (!existsSync(config.personModel)) {
        console.log(
          `[person-detect] 無効（モデル未配置: ${config.personModel}）— 動き検知のみで在室判定します`,
        );
        return;
      }
      const mod = (await import("onnxruntime-node")) as unknown as {
        default?: OrtModule;
      } & OrtModule;
      this.ort = (mod.default ?? mod) as OrtModule;
      this.session = await this.ort.InferenceSession.create(config.personModel, {
        logSeverityLevel: 3,
      });
      this.inputName = this.session.inputNames[0] ?? "images";
      this.outputName = this.session.outputNames[0] ?? "output";
      console.log("[person-detect] ONNX人物検出を開始（YOLOX-tiny）");
    } catch (e) {
      this.session = null;
      console.log(
        "[person-detect] 無効（onnxruntime-node 読み込み失敗）:",
        (e as Error).message,
      );
    }
  }

  /**
   * RTSPから1フレーム取り, 人物の有無を判定する.
   * 取得失敗・推論失敗は null（判定不能. 在室判定の根拠に使わない）.
   */
  async detect(rtspUrl: string): Promise<PersonDetection | null> {
    if (!this.session || !this.ort) return null;
    const bgr = await this.grabFrame(rtspUrl);
    if (!bgr) return null;
    try {
      // HWC(bgr24, 0-255) → CHW float32（YOLOXは正規化なし・BGRのまま）.
      const n = INPUT_SIZE * INPUT_SIZE;
      const data = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) {
        data[i] = bgr[i * 3]!;
        data[n + i] = bgr[i * 3 + 1]!;
        data[2 * n + i] = bgr[i * 3 + 2]!;
      }
      const tensor = new this.ort.Tensor("float32", data, [
        1,
        3,
        INPUT_SIZE,
        INPUT_SIZE,
      ]);
      const out = await this.session.run({ [this.inputName]: tensor });
      const o = out[this.outputName];
      if (!o) return null;
      // 出力 [1, アンカー数, 85] = [cx,cy,w,h, objectness, 80クラス確率(sigmoid済)].
      // 在室判定は「人がいるか」だけなので, box復号やNMSは不要で
      // objectness×person確率の最大値だけを見る.
      const ch = o.dims[2] ?? 85;
      const anchors = o.dims[1] ?? 0;
      let best = 0;
      for (let a = 0; a < anchors; a++) {
        const base = a * ch;
        const s = (o.data[base + 4] ?? 0) * (o.data[base + 5 + PERSON_CLASS] ?? 0);
        if (s > best) best = s;
      }
      return { found: best >= config.personScoreThreshold, score: best };
    } catch (e) {
      console.log("[person-detect] 推論に失敗:", (e as Error).message);
      return null;
    }
  }

  /**
   * ffmpegでRTSPから1フレームを取り, YOLOX流儀のletterbox
   * （アスペクト比維持で縮小し, 余白を114で埋める）でBGR24生画像にする（失敗は null）.
   */
  private grabFrame(rtspUrl: string): Promise<Buffer | null> {
    const expect = INPUT_SIZE * INPUT_SIZE * 3;
    const vf =
      `scale=${INPUT_SIZE}:${INPUT_SIZE}:force_original_aspect_ratio=decrease,` +
      `pad=${INPUT_SIZE}:${INPUT_SIZE}:0:0:color=${PAD_COLOR}`;
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-rtsp_transport",
      "tcp",
      "-i",
      rtspUrl,
      "-frames:v",
      "1",
      "-vf",
      vf,
      "-pix_fmt",
      "bgr24",
      "-f",
      "rawvideo",
      "pipe:1",
    ];
    return new Promise((resolve) => {
      const proc = spawn("ffmpeg", args);
      const chunks: Buffer[] = [];
      proc.stdout.on("data", (c: Buffer) => chunks.push(c));
      proc.on("error", () => resolve(null));
      proc.on("close", () => {
        const buf = Buffer.concat(chunks);
        resolve(buf.length >= expect ? buf.subarray(0, expect) : null);
      });
    });
  }
}
