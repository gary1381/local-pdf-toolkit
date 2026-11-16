"""One-off: turn the API's user-facing messages into English (agents and the
English UI read them). Run from the repo root; prints anything left over."""
import re
from pathlib import Path

PAIRS = {
    # gateway/app/routers/pdf.py
    "编辑会话已过期或不存在，请重新打开文件": "The editing session has expired or does not exist; open the file again",
    '{action}超时：文件可能太大，请稍后重试': '{action} timed out: the file may be too large; try again later',
    "PDF 已加密，或输入的密码不正确": "The PDF is encrypted, or the password is wrong",
    '"页码超出文档范围"': '"Page number is outside the document"',
    '{action}失败：字体不支持其中的某些字符': '{action} failed: the font has no glyphs for some of the characters',
    "OCR 语言不可用，目前支持 eng（英文）、chi_sim（简体中文）和 chi_tra（繁体中文）":
        "OCR language not available; supported: eng (English) and chi_sim (Chinese)",
    "图片格式不受支持，请使用 PNG 或 JPEG": "Unsupported image format; use PNG or JPEG",
    "没有字段被更新：字段可能不存在或为只读": "No field was updated: the fields may not exist or are read-only",
    "这个 PDF 没有可填写的表单字段": "This PDF has no fillable form fields",
    '{action}失败：无法处理该 PDF（文件可能已损坏或格式不受支持）':
        '{action} failed: the PDF could not be processed (it may be damaged or unsupported)',
    '{action}失败：后台服务未启动或正在重启，请稍后重试':
        '{action} failed: a background service is not running or is restarting; try again shortly',
    '{action}失败：服务器内部错误': '{action} failed: internal server error',
    '"文件为空"': '"The file is empty"',
    "文件太大（上限 {settings.max_upload_mb} MB）": "File too large (limit {settings.max_upload_mb} MB)",
    "「{file.filename or '文件'}」不是有效的 PDF 文件": "'{file.filename or 'file'}' is not a valid PDF file",
    '"图片为空"': '"The image is empty"',
    "图片太大（上限 20 MB）": "Image too large (limit 20 MB)",
    "请提供 PDF 文件或 document_id": "Provide a PDF file or a document_id",
    "这一步已超出可撤销的范围": "That step is beyond the undo history",
    '"渲染页面"': '"Rendering the page"',
    "合并至少需要两个 PDF 文件": "Merging needs at least two PDF files",
    "文件总大小超过上限（{settings.max_upload_mb * 2} MB）": "Total size is over the limit ({settings.max_upload_mb * 2} MB)",
    '"合并"': '"Merge"',
    "页码范围格式不正确，例如 1-3,5,8-": "Invalid page range; use a form like 1-3,5,8-",
    '"拆分"': '"Split"',
    "页码范围超出文档页数，没有可拆分的页面": "The page range is outside the document; nothing to split",
    '"提取文本"': '"Text extraction"',
    '"读取文档信息"': '"Reading document info"',
    '"读取表单"': '"Reading form fields"',
    '"读取文本框"': '"Reading text boxes"',
    '"请输入密码"': '"Enter a password"',
    "密钥长度只能是 128 或 256": "Key length must be 128 or 256",
    '"加密"': '"Encryption"',
    '"添加便签"': '"Adding a note"',
    '"添加标注框"': '"Adding a callout"',
    '"写入文字"': '"Writing text"',
    "表单数据格式不正确：values 必须是 JSON 对象": "Invalid form data: values must be a JSON object",
    '"填写表单"': '"Filling the form"',
    '"高亮"': '"Highlight"',
    '"擦除高亮"': '"Removing highlights"',
    '"替换文字"': '"Replacing text"',
    '"擦除区域"': '"Erasing a region"',
    '"移动文字"': '"Moving text"',
    "文本框数据格式不正确：placements 必须是 JSON 数组": "Invalid text box data: placements must be a JSON array",
    '"保存文本框"': '"Saving text boxes"',
    '"放置图片"': '"Placing an image"',
    "一次放置的签名太多": "Too many signatures in one request",
    "签名位置数据格式不正确": "Invalid signature placement data",
    "签名写入方式不正确": "Invalid signature mode",
    '"放置签名"': '"Placing signatures"',
    '"证书文件为空"': '"The certificate file is empty"',
    '"证书文件太大"': '"The certificate file is too large"',
    "时间戳服务器地址必须以 http:// 或 https:// 开头": "The timestamp server URL must start with http:// or https://",
    "签名区域太小": "The signature box is too small",
    '"数字签名"': '"Digital signing"',
    '"验证签名"': '"Signature verification"',
    '"读取证书"': '"Reading the certificate"',
    "请填写姓名": "Enter a name",
    "证书密码至少 4 位": "The certificate password needs at least 4 characters",
    '"生成证书"': '"Creating the certificate"',
    "旋转角度只能是 90、180 或 270 度": "Rotation must be 90, 180 or 270 degrees",
    "页码范围格式不正确，例如 1,3-5": "Invalid page range; use a form like 1,3-5",
    '"旋转"': '"Rotation"',
    "页面顺序格式不正确，例如 3,1,2": "Invalid page order; use a form like 3,1,2",
    "页码必须从 1 开始": "Page numbers start at 1",
    "页面顺序里有重复的页码": "The page order repeats a page",
    '"调整页面"': '"Reordering pages"',
    "mode 只能是 all、print 或 screen": "mode must be all, print or screen",
    '"扁平化"': '"Flattening"',
    '"解锁"': '"Unlocking"',
    "文字识别（OCR）组件还没有安装": "The OCR (text recognition) component is not installed",
    "请至少选择一种 OCR 语言": "Choose at least one OCR language",
    "不支持的 OCR 语言：{', '.join(unknown)}（可用：eng、chi_sim）":
        "Unsupported OCR language: {', '.join(unknown)} (available: eng, chi_sim)",
    # gateway/app/main.py, auth.py
    "跨站请求被拒绝": "Cross-site request refused",
    "上传内容太大（单个文件上限 {settings.max_upload_mb} MB）": "Upload too large (limit {settings.max_upload_mb} MB per file)",
    '"请求参数不正确" + (f"：{\', \'.join(fields)}" if fields else "")':
        '"Invalid request parameters" + (f": {\', \'.join(fields)}" if fields else "")',
    "API Key 不正确或缺失（在「设置」里填写）": "API key missing or wrong (send it in the X-API-Key header)",
    # services/ocr/app/main.py
    "这个 PDF 有数字签名，识别文字会改动文件、使签名失效，所以没有处理":
        "This PDF is digitally signed; OCR would change it and break the signature, so it was left as it is",
    "无法读取这个 PDF：文件可能已损坏，或者不是 PDF": "Cannot read this PDF: the file may be damaged or not a PDF",
    # Signatures.java
    'stamp.setContents("签名")': 'stamp.setContents("Signature")',
    '"证书密码不正确"': '"Wrong certificate password"',
    '"无法读取证书文件，请选择 .p12 或 .pfx 证书"': '"Cannot read the certificate; use a .p12 or .pfx file"',
    '"证书里的私钥无法使用："': '"The private key in the certificate cannot be used: "',
    '"证书文件里没有私钥，无法用来签名"': '"The certificate file has no private key, so it cannot sign"',
    '"请选择证书文件"': '"Provide a certificate file"',
    '"证书已过期（有效期到 "': '"The certificate has expired (valid until "',
    'getNotAfter()) + "）"': 'getNotAfter()) + ")"',
    '"证书还没有生效"': '"The certificate is not valid yet"',
    '"签名框“" + req.fieldName() + "”不存在或已经签过名"': '"Signature field \'" + req.fieldName() + "\' does not exist or is already signed"',
    '"找不到签名框所在的页面"': '"Cannot find the page of the signature field"',
    '"数字签名："': '"Digitally signed by "',
    '"日期："': '"Date: "',
    '"原因："': '"Reason: "',
    '"地点："': '"Location: "',
    '"时间戳服务器返回错误（HTTP " + conn.getResponseCode() + "）"': '"The timestamp server returned an error (HTTP " + conn.getResponseCode() + ")"',
    '"无法连接时间戳服务器："': '"Cannot reach the timestamp server: "',
    '"时间戳服务器拒绝了请求："': '"The timestamp server refused the request: "',
    '"不支持验证这种签名格式（" + sub + "）"': '"This signature format cannot be verified (" + sub + ")"',
    '"签名里没有签名人的证书"': '"The signature does not contain the signer\'s certificate"',
    '"签名无效：签名后的内容被改动过，或签名已损坏"': '"Invalid: the document was changed after signing, or the signature is damaged"',
    '"签名完整，但签名时证书不在有效期内"': '"Intact, but the certificate was not valid at signing time"',
    '"签名完整，文件未被改动；证书是自签名的，无法确认签名人身份"': '"Intact and unchanged; the certificate is self-signed, so the signer\'s identity is not confirmed"',
    '"签名完整，文件未被改动（证书颁发者："': '"Intact and unchanged (certificate issued by "',
    '.get("issuer") + "，未联网检查吊销状态）"': '.get("issuer") + "; revocation not checked online)"',
    '"无法验证签名："': '"Cannot verify the signature: "',
}

FILES = [
    "gateway/app/routers/pdf.py",
    "gateway/app/main.py",
    "gateway/app/auth.py",
    "services/ocr/app/main.py",
    "services/pdfbox/src/main/java/com/pdfgateway/Signatures.java",
]

cjk = re.compile(r"[一-鿿]")
for name in FILES:
    path = Path(name)
    text = path.read_text(encoding="utf-8")
    for zh, en in PAIRS.items():
        text = text.replace(zh, en)
    path.write_text(text, encoding="utf-8")
    for i, line in enumerate(text.splitlines(), 1):
        if cjk.search(line):
            print(f"LEFT {name}:{i}: {line.strip()[:140]}")
