# Steam 自动助手 / Steam 喜加一插件

Steam 客户端内嵌浏览器扩展，一键领取限时免费游戏，可选在启动 Steam 后自动运行指定游戏。

仓库内包含两个版本，功能层层递进，按需要装其中一个即可，不需要两个都装。

## 一、两个版本怎么选

| 版本 | 仓库目录 | 功能范围 | 适用人群 | 当前版本号 | 下载包名 |
| --- | --- | --- | --- | --- | --- |
| 喜加一版（lite） | `lite/steam-free-claimer/` | 限时免费游戏查询、一键领取 | 只需要领游戏，不希望有任何后台进程的用户 | 1.0.0 | `Steam喜加一插件.zip` |
| 自动助手版（full） | `full/steam-free-claimer/` | 喜加一版的全部功能，外加启动 Steam 后自动运行勾选的游戏 | 需要挂卡、挂机、固定开局游戏的用户 | 2.1.4 | `Steam自动助手_2.1.4.zip` |

比较项补充：两个版本共用同一套悬浮球与面板界面，领取逻辑完全一致，差别只在于自动助手版多一个本地 helper 进程负责自动启动游戏。

## 二、版本号规则

- `1.x`：喜加一独立版。日常小改动（样式、提示文案、领取逻辑小修补）只递增小版本号，例如 `1.0.0 → 1.0.1`，主版本号 `1` 保持不变。
- `2.x`：加入开机自启与自动启动游戏这一整套大功能后的升级版。只有再次加入同等量级的大功能，才把主版本号从 `2` 升到 `3`；普通修复仍然只递增小版本号。

## 三、安装步骤

两个版本的安装方式完全一致，解压后得到的文件夹名都是 `steam-free-claimer`。

1. 打开 Steam，进入商店页面，在任意游戏或链接上右键，选择「在新选项卡中打开链接」，会弹出一个带地址栏的 Steam 内置浏览器窗口。
2. 在这个窗口的地址栏里粘贴 `chrome://extensions` 并回车，打开扩展管理页。
3. 勾选右上角「开发者模式」，点击「加载已解压的扩展程序」，选择解压出来的 `steam-free-claimer` 文件夹。
4. 扩展加载完成后回到商店页面，右下角就会出现悬浮球，点开即可使用。
5. 注意：商店页不会因为按下 F5 而刷新，需要点击顶部导航栏的「商店」按钮，或者点击页面下方地址栏左侧的刷新按钮。

## 四、自动助手版的额外配置

自动助手版多一个 `helper` 目录，里面是一个本地 PowerShell 助手，负责在 Steam 启动时把勾选的游戏拉起来。

- 注册开机自启：在 `helper` 目录下右键 `install-autostart.ps1`，选择「使用 PowerShell 运行」。脚本会在当前用户的「启动」文件夹里创建指向 `start-helper.vbs` 的快捷方式，并立刻启动一次助手。
- 取消开机自启：以同样方式运行 `uninstall-autostart.ps1`。
- 也可以不注册自启，直接双击 `helper/start-helper.vbs` 手动启动。
- 助手默认监听 `127.0.0.1:17380`，只接受本机请求，不对外开放。扩展面板里的「自动启动」页签连接的就是这个地址。
- `helper/config.json`（游戏勾选与本机路径）与 `helper/helper.log`（运行日志）属于运行时数据，首次使用后自动生成，已在 `.gitignore` 中排除，不随仓库分发。

## 五、目录结构

```
steam-auto-assistant/
├─ README.md
├─ LICENSE
├─ .gitignore
├─ .gitattributes
├─ lite/
│  └─ steam-free-claimer/           喜加一版（1.0.0）
│     ├─ manifest.json
│     ├─ content.js
│     ├─ background.js
│     ├─ popup.html / popup.css / popup.js
│     ├─ options.html / options.js
│     ├─ README.md
│     ├─ 使用说明.md
│     └─ 使用说明.html
└─ full/
   └─ steam-free-claimer/           自动助手版（2.1.4）
      ├─ manifest.json
      ├─ content.js
      ├─ background.js
      ├─ popup.html / popup.css / popup.js
      ├─ options.html / options.js
      ├─ README.md
      ├─ 使用说明.md
      ├─ 使用说明.html
      ├─ backup-v1/
      │  └─ content.js              早期版本留档，不参与加载
      └─ helper/
         ├─ helper.ps1              本地助手主程序
         ├─ start-helper.vbs        静默启动入口
         ├─ install-autostart.ps1   注册开机自启
         ├─ uninstall-autostart.ps1 取消开机自启
         ├─ custom-games.json       自定义游戏列表
         └─ 使用说明.txt
```

编码说明：仓库内所有文本文件均为 UTF-8 编码（`helper.ps1` 等 PowerShell 脚本为 UTF-8 带 BOM，`start-helper.vbs` 为 UTF-16 LE，其余为 UTF-8 无 BOM），`.gitattributes` 使用 `* -text` 禁止 Git 做换行与编码转换，保证克隆下来中文不乱码。

## 六、下载

前往本仓库 Releases 页面下载打包好的压缩包：

| 压缩包 | 对应版本 |
| --- | --- |
| `Steam喜加一插件.zip` | 喜加一版 1.0.0（lite） |
| `Steam自动助手_2.1.4.zip` | 自动助手版 2.1.4（full） |

两个压缩包内均为 `steam-free-claimer/` 目录，解压后直接按第三节的安装步骤加载即可。

## 七、免责声明

- 本项目仅供个人学习与技术研究使用。
- 扩展不涉及任何账号凭据，不读取、不上传 Steam 账号密码、Cookie 或登录令牌。
- 「一键领取」等同于在商店页面手动点击「添加到账户」，最终是否成功由 Steam 服务器决定。
- 使用本项目产生的一切后果由使用者自行承担，请遵守 Steam 服务条款。
