# 网店发票填写器

Chrome 扩展，用于把网店待开票账单截图交给本地 MiniMax OCR bridge 识别，再把合计金额和开票模板填入厦门电子税务局蓝字发票开具页面。

## 首版流程

1. 启动本地 OCR bridge。
2. 在 Chrome 加载本项目扩展。
3. 打开网店待开票账单页面，确认页面中显示需要识别的账单。
4. 点击扩展图标，点击“识别网店账单”。
5. 打开税局页面：`https://dppt.xiamen.chinatax.gov.cn:8443/blue-invoice-makeout/invoice-makeout`。
6. 点击扩展图标，点击“填充税局开票页”。
7. 人工核对所有字段后，再由人工决定是否保存草稿或开票。

## 本地 OCR bridge

```sh
cp .env.example .env
cd server
npm install
npm run bridge
```

`.env` 中需要配置：

```sh
MINIMAX_API_KEY=your_key_here
MINIMAX_API_HOST=https://api.minimaxi.com
```

不要把 `.env` 提交到 Git。

## Chrome 加载

1. 打开 `chrome://extensions/`。
2. 打开“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目根目录。

## 安全边界

- 扩展不会保存 MiniMax key。
- 账单批次保存在 `chrome.storage.session`，属于临时数据。
- 开票模板保存在 `chrome.storage.local`，可在弹窗里调整。
- 税局页面填充完成后不会自动点击“开票”“提交”“上传发票”等按钮。

## 项目结构

```text
.
├── manifest.json
├── popup.html
├── popup.css
├── popup.js
├── src/
│   ├── storage.js
│   └── taxFiller.js
└── server/
    ├── bridge.js
    └── package.json
```
