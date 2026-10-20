# dsh-social

> 一个只读的窗户。她可以看，不可以说话。

给 DSH 陪伴型 agent 用的社交平台浏览插件。当前只支持 B 站。

## 一句话

**`dsh-social` 让 agent 知道外面发生了什么，但不给它任何对外发言的通道。**

这条边界不是「以后再补」，是设计本身：

- 没有 `post`、没有 `comment`、没有 `like`、没有 `follow`、没有私信；
- 不登录、不签名、不用 cookie；
- 只调两个匿名公开接口。

理由：一个要读陌生人文字的 agent，手里不能握着一个能替她说话的手柄。平台的惩罚是封号，而封号是不可逆的。

## 为什么只有 B 站，只有热门

实测（2026-10-20，干净 IP）：

| 接口 | 结果 | 结论 |
|---|---|---|
| `x/web-interface/popular` | `code: 0`，20 条 | ✅ 用 |
| `x/web-interface/view?bvid=` | `code: 0`，完整元数据 | ✅ 用 |
| `x/web-interface/ranking/v2` | `code: -352` | ❌ 要 `wbi` 签名，不实现 |
| `x/web-interface/search/type` | HTTP 412 `request was banned` | ❌ 风控，不实现 |

这不是「以后有时间再补签名」。一个每天早上都被风控挡住的窗口，比一个只有热门的窗口更糟：它会让人误以为插件坏了，或者更糟——静默返回空，让人以为今天没有新东西。

**只做能长期稳定工作的那部分。**

## 安装

```powershell
cd D:\A\DSH-L\agent
node node_modules\@deepseek-ai\dsh\lib\bin.js plugin --profile b add "D:\A\DSH\ls\1\plugins\dsh-social"
```

或手工在 profile 的 `cordis.patch.yml` 里插入：

```yaml
- insert:
    - id: social
      name: dsh-social
```

## 配置

```yaml
- id: social
  name: dsh-social
  config:
    enabled: true
    dataPath: ''            # 空 = $DSH_HOME/social/views.jsonl
    interests: ['猫', '画画', '独立游戏']
    maxRows: 5000
    gapMs: 1500
    fill: false
    dailyBudget: 60
    schedule:
      enabled: false        # 默认关；打开后按 times 定点看
      times: ['08:30', '20:30']
      limit: 20
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉则完全不发请求 |
| `dataPath` | `''` | JSONL 落盘位置 |
| `interests` | `[]` | 关键词，用于给每行打分（0–1） |
| `maxRows` | `5000` | 压缩后保留行数；文件在 1–2 倍之间波动 |
| `gapMs` | `1500` | 两次请求之间等多久 |
| `fill` | `false` | 是否逐条调详情接口补全描述（每条多一次请求） |
| `dailyBudget` | `60` | 每天最多新增多少行；0 = 禁止 |
| `schedule.enabled` | `false` | 是否定时看 |
| `schedule.times` | `['08:30','20:30']` | `HH:mm`，严格解析，非法值会被跳过并警告 |
| `schedule.limit` | `20` | 每次定时看多少条 |

## 命令

```
/social                 状态：看了多少、最近一次结果
/social look [n]        现在看一次（默认 20）
/social recent [n]      最近看到的（默认 10）
/social open <bvid>     看一个具体视频，可带 bilibili: 前缀
```

命令是给人的，不是给模型的。**没有注册成工具。** 工具会把「去看互联网」放进一个陌生人能写入的回合里，而窗户是唯一一处「被注入的一句话可以决定她下一步读什么」的地方。

## 服务

其他插件可以通过 `ctx.social` 调用：

```js
const run = await social.look({ limit: 20 });
const rows = social.recent({ limit: 5, minInterest: 0.3 });
const one = social.get('bilibili:BV1pGnn67EbB');
const state = social.status(); // { total, byPlatform, lastRun }
```

同时会发 `social/view` 事件（每新增一行一次），供 `dsh-proactive` 之类订阅。

## 数据

`$DSH_HOME/social/views.jsonl`，一行一条：

```json
{"id":"bilibili:BV1pGnn67EbB","platform":"bilibili","nativeId":"BV1pGnn67EbB","url":"https://www.bilibili.com/video/BV1pGnn67EbB","title":"…","author":"影视飓风","description":"…","cover":"…","tags":["数码"],"duration":2682,"views":1222805,"likes":108094,"publishedAt":1792400400000,"seenAt":1792400500000,"interest":0.15}
```

刻意很薄：标题、作者、一段描述、几个计数。不是弹幕、不是评论、不是视频。

## 兴趣打分

纯算术，不调模型。每行每次运行都算一次，付钱让模型判断「你可能喜欢猫」是荒唐的——她记住自己喜欢猫就行了。

```
score = min(标题/描述/标签/作者里命中的兴趣词, 3) × 0.25
      + min(播放量 / 100万, 1) × 0.15
```

上限 1.0。播放量权重封顶 0.15，否则同一个爆款视频会每天早上重新出现。

## 测试

```powershell
cd D:\A\DSH\ls\1\plugins\dsh-social
npm test                        # 断言套件，不需要网络
node test/live-bilibili.mjs 3   # 实网探针，需要网络
```

三个套件：`bilibili`（归一化、风控降级、网络失败）、`store`（去重、压缩、坏行）、`command`（命令解析、预算、时钟）。

## 边界

- **不发布。** 没有写路径。
- **不评论、不点赞、不关注、不私信。**
- **不登录。** 没有 cookie，没有 token。
- **不签名。** 需要 `wbi` 的接口直接不做。
- **不批量抓取。** 每天最多 `dailyBudget` 行，请求之间有 `gapMs`。
- **不冒充真人。** 它就是插件在读数，不是一个人在刷 B 站。

## 已知限制

- 只有热门流，没有搜索、没有排行榜、没有关注动态。
- `fill: true` 会显著增加请求量，默认关。
- 抖音未实现（分享链接解析需要另外的抓取路径，二期）。
- 评论区未实现（`x/v2/reply` 需要正确的 `oid`，且是另一个风控面）。
- 不处理登录态；如果 B 站哪天对匿名热门流也收紧，这个插件会**报错**而不是静默返回空——`errors` 数组就是为此存在的。

## 许可

MIT。README 里引用的接口行为来自 2026-10-20 的实测，平台改动不在控制范围内。