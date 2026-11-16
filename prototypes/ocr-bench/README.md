# OCR 对比原型：Tesseract vs RapidOCR

这是一个原型，不是产品代码。它比较当前的 OCR（Tesseract，经 OCRmyPDF）和 RapidOCR（PaddleOCR 的 ONNX 模型）。

## 结果（2026-10-11，开发机，CPU）

字错率（CER）比较时忽略空格，并统一全角/半角。英文单词一栏统计的是完全正确的单词数，空格丢了就算错。

| 测试集 | 引擎 | 平均字错率 | 错字超过 15% 的页 | 英文单词完全正确 | 每页耗时 |
|---|---|---|---|---|---|
| 普通扫描件 21 页（200 dpi） | Tesseract | 0.036 | 1 | 289/289 | 1.9 s |
| | RapidOCR | **0.000** | 0 | 289/289 | 1.6 s |
| 劣质扫描件 12 页（150 dpi、小字、噪点、模糊、倾斜） | Tesseract | 0.083 | 3（都是中文页） | 225/229 | 2.5 s |
| | RapidOCR | **0.001** | 0 | 227/229 | 1.6 s |

说明：

- 测试页是用字体渲染再加噪点得到的模拟扫描件，不是真实扫描件。
- Tesseract 的耗时包含 PDF 读入和写出。RapidOCR 的耗时只算识别本身。

## RapidOCR 的设置

- RapidOCR 3.10，默认模型 PP-OCRv6 small，加上方向分类模型，共约 32 MB。
- 它的中文模型有时会丢掉英文单词之间的空格（例如 "phoneor"）。处理办法：没有中文的行，再用英文模型（PP-OCRv5 mobile）识别一遍；只有两次识别的字符完全一致时，才采用英文模型的结果，因为它的空格更准。处理后英文单词全部正确。
- 许可证：代码和模型都是 Apache-2.0；依赖都是宽松许可（onnxruntime 用 MIT，OpenCV 用 Apache-2.0，numpy 和 shapely 用 BSD）。

## 体积

- 当前 OCR 镜像（Tesseract + OCRmyPDF）：409 MB。
- 原型镜像未做任何裁剪，有 744 MB。其中 OpenCV 约 150 MB，onnxruntime 68 MB，numpy 70 MB。
- 如果要比现在更小，需要换掉 OpenCV，或者改用 RapidOCR 的 C++ 或 ONNX 精简实现。

## 接入软件后（services/ocr，2026-10-11）

OCR 服务改用 RapidOCR，OCRmyPDF 仍负责处理页面和写入隐形文字层。下面的数字是从输出 PDF 的文字层读回来算的，不是识别器的原始结果。

| 测试集 | 字错率 | 英文单词全对 | 文字层字符落在图中文字上 |
|---|---|---|---|
| 普通扫描件 21 页 | 0.0002 | 289/289 | 100% |
| 劣质扫描件 12 页 | 0.0029 | 229/229 | 99.8% |
| 笔记表格（真实截图） | 找回原文 100%，准确率 99.6% | — | 98.9% |
| 简历（真实图片） | 找回原文 99.4%，准确率 99.4% | — | 96.3% |

设置和原因：

- 检测用 PP-OCRv6 tiny，识别用 PP-OCRv6 small。tiny 的 CPU 开销约为 small 的三分之一（每页 1.1 秒对 3.2 秒），准确率几乎一样。
- 不用每行方向分类器：它偶尔会把稍微倾斜的正向文字行翻转 180°，读出乱码。页面方向由 OCRmyPDF 处理。
- 不含中文的行再用英文模型读一遍；两次读出的字符一致时，才采用英文模型的结果，以补回单词间的空格。
- 倾斜的行按真实行框加基线斜率写入文字层。注意 OCRmyPDF 渲染器的斜率符号和它文档里写的相反。
- 识别在服务进程内运行，页面在线程里并行处理，模型只在启动时加载一次。所有引擎对象共用，因此调用时不能传参数：RapidOCR 会把调用参数存到对象上，影响之后的调用。
- 关闭了 ONNX Runtime 线程的空转等待（省约 15% CPU），也关闭了它的使用统计上报（ORT_DISABLE_TELEMETRY=1）。

速度（开发机负载较高时，和 Tesseract 交替测量）：

- 单页约 1.2–1.4 秒，比 Tesseract（约 2.5 秒）快。
- 10 页约 8–9 秒，比 Tesseract（约 3.7 秒）慢，因为 RapidOCR 每页需要的计算量更大。

体积：

- 镜像 622 MB（Tesseract 版为 409 MB）。
- 安装时下载约 190 MB。
- 体积主要来自 OpenCV（约 150 MB）、onnxruntime 和 numpy。

检查脚本：

- `bench_engine.py`：识别准确率。
- `validate_outputs.py`：服务输出、文字层位置、各种异常文件、并行和顺序处理结果一致。
- `textlayer_check.py`：画出文字层叠加图，检查位置。

## 文件

- `Dockerfile`：原型镜像（`podman build -t localhost/openpdf-rapidocr-proto .`）
- `ocrfx.py`、`ocrbench.py`、`ocrhard.py`：生成测试页（需要挂载系统字体到 `/fonts`）
- `ocrcmp.py`、`tess_dir.py`：用 OCR 服务测 Tesseract
- `spaces.py`、`final_rapid.py`：测 RapidOCR，包括补英文空格的规则
- `cmp_all.sh`：两个引擎、两个测试集一起跑

这些脚本假定工作目录挂载在 `/w`（原来是 `/tmp/openpdf-design`）。
