# 本地语音运行时

实现入口为 `src/core/speech/`、`src/main/speech/` 和 `src/renderer/src/speech/`。手动朗读不属于 Agent 策略，不新增 Python 执行路径。首次在「设置 → 语音」安装约 327 MB 资源，随后通过已记录词汇、短语及英文例句旁的按钮朗读。播放条提供暂停、继续、停止和时间跳转。

## 固定身份与边界

- HeadTTS **1.3.0**，Transformers.js **4.0.0**，实际 ONNX Runtime **1.24.3**，完整传递依赖由 `pnpm-lock.yaml` 固定。
- 模型 `onnx-community/Kokoro-82M-v1.0-ONNX-timestamped`，revision `dd4401a9add81ac692d20e240d22ec9dda82cc29`，CPU / **FP32**；没有降精度或远程合成分支。
- 资源摘要及许可见 `resources/speech/headtts/manifest.json` 和 `NOTICE.txt`。模型安装在应用管理的 `speech/models/<revision>/`；设置独立保存在 `speech/settings.json`。开发验证始终使用临时目录。
- 重新安装在下载和校验完成后保留旧目录，再启用新目录；启用失败时回滚旧目录。若文件系统同时拒绝回滚，保留 `speech/backup-<uuid>/` 中的旧资源，并在本地诊断中保留启用与回滚的错误原因，不删除备份。
- 运行时使用一个 `utilityProcess` 和一个 HeadTTS Worker，无 HTTP 服务；子进程只继承环境白名单。Transformers 禁用远程模型与第三方缓存，加载前校验所有资源。Node Worker 只接收朗读文本和固定配置，不接收业务数据库、API Key 或会话标识。
- 单次最多 4,000 UTF-16 单元、每段 350 单元、20 段、360 秒音频、24 MiB；实际音素 token（含特殊 token）最多 511。队列最多 4 项，冷加载 / 单段 / 总截止为 120 / 60 / 180 秒。
- SQLite v13 将对话音频 BLOB 上限从 8 MiB 扩展到 24 MiB，并原样保留已有音频与元数据。真实用户数据库迁移须先取得用户许可；开发验证仅使用临时数据库。
- 新朗读替换本窗口旧请求；IPC 校验来源及请求归属。取消终止活动实例并丢弃迟到结果；之后的显式请求可以重新加载，失败请求不会重放。
- 缓存仅在内存中保留两个结果，键包含文本、语言、配置、模型 revision、精度和对齐版本；播放语速固定为 1，语速设置触发重新合成。
- 播放设备解锁期间的旧操作被暂停、跳转或停止替换后，不再提交播放状态；迟到的解锁失败同样不能覆盖新操作，当前有效操作的失败仍明确返回。

## 已验证的上游修正

上游 [HeadTTS 1.3.0 Worker](https://github.com/met4citizen/HeadTTS/blob/v1.3.0/modules/worker-tts.mjs) 在 tokenizer 调用中允许截断。启动包装器使用同一词典、音素转换和 tokenizer 预检实际 token 数，超限返回安全回执，由 Core 有界重分段，不让静默截断成为正常成功路径。

固定 ONNX 文件输出的 `durations` 是 `/encoder/Div` 的连续预测值，而波形内部使用 `/encoder/Round` → `/encoder/Clip` 后的整数帧数。直接累加连续值会产生漂移，真实 1.5 倍语速样本曾出现词尾超过波形约 70 ms。包装器在同一次推理结果上应用 ONNX ties-to-even 取整及最小一帧规则，并核验 **帧数总和 × 600 = 实际采样数**，随后让原 HeadTTS Worker 生成 `words/wtimes/wdurations`。不按比例缩放或裁剪时间戳。对齐身份为 `headtts-decoder-frames-v1`。模型原始实现的帧规则也可参见 [Kokoro 模型源码](https://github.com/hexgrad/kokoro/blob/main/kokoro/model.py)。

该版本 WAV 编码器将 RIFF 长度写为 `32 + PCM 字节数`，正确值为 `36 + PCM 字节数`。适配层只修复已确认的 4 字节头部差异，再执行完整 WAV 校验；不修改采样。

这些修正解决结构一致性和累计漂移，**不等于人工声学边界验收已经通过**。

## 可复现验证

无需资源的确定性检查：

```bash
UV_CACHE_DIR=/tmp/lingo-uv-cache pnpm agent:sync
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

显式准备一个新的测试专用模型目录；此命令下载固定资源，不运行应用，不接触数据库：

```bash
node scripts/speech-prepare-resources.mjs /tmp/lingo-speech-fp32
LINGO_MATE_SPEECH_TEST_RESOURCES=/tmp/lingo-speech-fp32 pnpm speech:test
pnpm speech:smoke --resources /tmp/lingo-speech-fp32 --report /tmp/speech-report.json --artifacts /tmp/speech-alignment
```

`speech:test` 是独立配置的真实进程集成测试，覆盖固定 30 条英语样本、两种音色及三种语速，使用临时用户目录，不创建窗口或加载业务数据库；不属于完整用户流程 E2E。缺失资源时明确失败，不跳过。常规 `pnpm test` 不隐式下载或执行这个资源套件。

检查本机打包布局时先构建，再使用安装布局内的运行入口执行相同无窗口烟测。例如 macOS arm64：

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --dir --mac --arm64 --config.mac.identity=null
pnpm speech:smoke --resources /tmp/lingo-speech-fp32 --runtime "dist/mac-arm64/Lingo Mate.app/Contents/Resources/app.asar/out/main/headtts-entry.js"
```

该布局检查使用开发 Electron 启动独立 harness，再从安装包加载运行入口、依赖及原生库。它不等于已签名安装应用的完整验收。运行前需存在本平台 Python 运行包（见 Agent Engine README）。Windows / Linux 及其他 CPU 必须在原生环境分别执行，不能据此宣称通过。

## 声学与设备验收

烟测 `--artifacts` 输出 30 个 WAV 和 `alignment-references.json`。该文件的人工参考边界初始为 `null`，不得用模型预测值回填后冒充人工参考。使用固定内置或有线设备听取并查看波形，逐项填写 `referenceStart`、`referenceEnd`，记录标注者、OS/CPU、设备和方法。执行：

```bash
node scripts/speech-alignment-check.mjs /tmp/speech-alignment/alignment-references.json
```

脚本要求至少 30 条样本、200 个边界和全部三种语速；缺失人工标注时报错。起点绝对误差 P95 必须 ≤ 100 ms，最大误差 ≤ 200 ms；同时报告结束边界误差，复核句尾停顿。未达到门槛时应修正并重新测量。

设备输出时钟及前台展示/订阅延迟 P95 ≤ 50 ms 需要有许可的 Electron 用户流程验收。`requestAnimationFrame` 仅刷新展示；同步 `getPlaybackSnapshot()` 直接读取音频输出时钟，后台回调不承诺实时性。无有效输出时钟时明确失败。

新增 `tests/e2e/speech.test.ts` 覆盖真实朗读、暂停冻结、继续、跳转、来源替换及停止。**仅在取得明确 E2E 许可后执行**，并显式提供测试资源：

```bash
LINGO_MATE_SPEECH_E2E_RESOURCES=/tmp/lingo-speech-fp32 pnpm test:electron
```

本次记录：E2E 未执行，按约定默认无问题。设备延迟、人工声学边界及其他平台仍未验收，不能标记为通过。
