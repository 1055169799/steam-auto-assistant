---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 1c5d716c42af2d9c2340d774b8f35819_3508be31d97e11f1ba6252540064ee0f
    ReservedCode1: mXFp5SrbqAJkl1iZYz856s87ZwE/g6fu7F4BzfiijXW9GPuSI74NGC4YvyPaP5Pg4+mx+ycUU7zaa6B/uo6Elphgpce8plY7+3jIFn4BNZAd0A1kBFRpUDLBNgH9LWTwtd+QgXCdSEs6/V2/OT4xVSLLJHUiWs9Wa3wrrUoZrq3NCUFJZVd19Q3k9oY=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 1c5d716c42af2d9c2340d774b8f35819_3508be31d97e11f1ba6252540064ee0f
    ReservedCode2: mXFp5SrbqAJkl1iZYz856s87ZwE/g6fu7F4BzfiijXW9GPuSI74NGC4YvyPaP5Pg4+mx+ycUU7zaa6B/uo6Elphgpce8plY7+3jIFn4BNZAd0A1kBFRpUDLBNgH9LWTwtd+QgXCdSEs6/V2/OT4xVSLLJHUiWs9Wa3wrrUoZrq3NCUFJZVd19Q3k9oY=
---

# Steam 喜加一助手

一个浏览器扩展：检索 Steam 当前的限时免费（Free to Keep）游戏，对比你自己的游戏库，把没拥有的自动领进库里。

既可以在普通 Chrome / Edge 里用，也可以在 **Steam 客户端内置的浏览器**里用（需要先装两个前置组件）。

---

## 一、在 Steam 客户端里使用的前置条件

Steam 客户端的内核是 CEF（Chromium Embedded Framework），**原生不支持安装 Chrome 扩展**，官方也没有扩展管理界面。要让它支持，需要两步：

| 步骤 | 组件 | 作用 |
|------|------|------|
| 1 | [Millennium](https://github.com/shdwmtr/millennium) | Steam 客户端插件/主题加载框架，把代码注入 steamwebhelper 进程 |
| 2 | [Extendium](https://github.com/BossSloth/Extendium) | Millennium 插件，为 Steam 客户端补上 Chrome 扩展加载能力与扩展管理界面 |

安装顺序：

1. 安装 Millennium，重启 Steam
2. 从 Extendium 的 Releases 下载，解压到 Steam 目录下的 `plugins` 文件夹
3. 启动 Steam → Millennium 设置中启用 Extendium → 保存并重启
4. 在商店页面地址栏右侧点击拼图图标，或按 `Win+R` 执行 `steam://extendium/manager` 打开扩展管理器
5. 加载本扩展（见下节）

> 注意：Extendium 仍处于活跃开发中，部分 Chrome API 的行为与正式 Chrome 并不完全一致。
> 如果某个 API 在 Steam 内不可用，本扩展已做降级处理（不依赖 `chrome.cookies`，登录态由页面上下文自行读取）。

---

## 二、加载本扩展

### 方式 A：普通 Chrome / Edge（推荐先在这里验证）

1. 打开 `chrome://extensions/`
2. 右上角开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本目录
4. 在浏览器中登录 `https://store.steampowered.com/`，点击工具栏图标即可

### 方式 B：Steam 客户端（Extendium）

1. 打开 Extendium 扩展管理器（拼图图标 / `steam://extendium/manager`）
2. 选择「加载已解压的扩展程序」，指向本目录
3. 在 Steam 内置浏览器里打开商店并登录，然后使用扩展

---

## 三、使用

点击图标打开面板：

- **扫描限免** —— 检索当前所有 100% 折扣条目，逐个解析可领取的 package，与你的游戏库比对
- **自动领取** —— 开关。**默认关闭**，关闭状态下只生成报告，你可以按报告里的游戏名自己去商店领
- **⚙** —— 打开设置：请求间隔、黑白名单、每日定时扫描

后台会按设定的时刻自动扫描一次（默认每天 10:00）。

---

## 四、工作流程

```
确认登录态 GET /dynamicstore/userdata/  →  响应为 JSON 且含 rgOwnedApps 数组即已登录
        ↓
检索 /search/results/?maxprice=free&specials=1&json=1
        ↓  解析 data-ds-appid / data-ds-packageid
读取 /dynamicstore/userdata/  →  rgOwnedApps（你的库）
        ↓  过滤已拥有
解析 /api/appdetails/?appids=X&filters=packages  →  package_groups
        ↓  只保留 is_free_license === true 且 price === 0 的 sub
POST /freelicense/addfreelicense/{subid}
   { action: "add_to_cart", sessionid: "..." }
        ↓  按 purchase_result_detail 分类
   0/空 = 领取成功   9 = 已拥有   24 = 需要本体   15 = 区域限制
```

最后一次 POST 与你在商店页点「添加到账户」按钮发出的请求完全一致。

### 为什么必须筛选 package

同一个 app 下面，Steam 经常**同时挂着限免促销包和原价付费包**。实测：

| appid | packageid | is_free_license | 价格 | option_text |
|-------|-----------|-----------------|------|-------------|
| 4693960 | 1782986 | `true` | ¥0 | ... Limited Free Promotional Package - Oct 2026 |
| 4693960 | 1633607 | `false` | ¥22 | Hunting Simulator 3 - Classic American Hunter Pack |

如果不加筛选直接遍历 `packages` 数组，就可能对着 **1633607 这个 ¥22 的付费包**发 `addfreelicense`，触发的是购买流程而不是领取。扩展因此做了两层判定：

1. `is_free_license === true` 且 `price_in_cents_with_discount === 0` —— 剔除所有付费包
2. 再优先匹配 `Limited Free Promotional Package` 标识；名称格式变化时退回第 1 层结果，避免漏领

> 另注：**不能用 `is_free` 字段判断永久免费游戏**。限免促销打到 0 元时 Steam 也会把 `is_free` 置为 `true`，实测限免 DLC 与 CS2 的 `is_free` 都是 true，该字段无区分力。

所有请求都在 `store.steampowered.com` 的页面上下文内发出（content script），因此天然携带登录 Cookie，无需扩展申请 cookie 权限，也不存在凭据外流。

---

## 五、目录结构

```
steam-free-claimer/
├── manifest.json      MV3 清单
├── background.js      后台调度：标签页管理、定时任务、报告持久化
├── content.js         页面内执行器：检索、库比对、领取（核心逻辑）
├── popup.html/js/css  弹出面板
├── options.html/js    设置页
└── README.md
```

---

## 六、风险与合规说明

- 自动领取等价于**脚本化点击**，属于 Steam 用户协议中「第三方自动化工具」的灰色地带。业界已有账号因高频批量领取被标记的先例。
- 因此本扩展默认：**不自动领取**、**带 3–9 秒随机间隔**、**单次扫描上限约 600 条**。请保持这个节奏，不要为了快而把间隔调到 1 秒以内。
- 本扩展不收集、不上传任何数据，不申请 `cookies` 权限，不读取你的登录凭据。所有网络请求直达 Valve 官方域名。
- 若你的账号出现领取异常，请立即关闭自动领取，改用报告模式手动领取。

---

## 七、常见问题

**Q：扫描完显示"未检测到登录状态"**
登录态由页面上下文请求 `/dynamicstore/userdata/` 实测判定（已登录会返回含 `rgOwnedApps` 的 JSON，未登录会回落登录页 HTML）。
看到这条提示说明该接口确实把你当未登录：请在 Steam 内置浏览器中打开商店首页，确认右上角显示你的头像，然后重新打开扩展。

**Q：扫描完显示"登录状态检测失败：无法访问 Steam 接口"**
这与未登录是两回事——探针请求没能发出去或没拿到正常响应（断网、Steam 接口临时异常、页面被拦截等），
且页面上也找不到任何登录痕迹。请检查网络后刷新商店页重试；面板登录行此时显示"登录状态未知"。

**Q：全部显示"已拥有"**
说明检索到的都是永久免费游戏（Free to Play）。限时免费条目在你的筛选条件下可能刚好为空，属于正常情况。

**Q：领取显示"需要本体"**
该条目是游戏本体的 DLC 或捆绑包，需先拥有本体才能领取，无法绕过。

**Q：在 Steam 里点了没反应**
确认 Extendium 已启用且本扩展在管理器中处于开启状态；也可以先在 Chrome 里验证扩展本身工作正常，再排查 Steam 侧。

**Q：CEF 版本较老导致 MV3 报错**
可以改写为 MV2：把 manifest 的 `manifest_version` 改为 2，`background.service_worker` 改为 `background.scripts`，并把 `chrome.storage.session` 全部替换为 `chrome.storage.local`。
*（内容由AI生成，仅供参考）*
*（内容由AI生成，仅供参考）*
