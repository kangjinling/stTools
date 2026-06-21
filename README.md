# 股票买点评估工具

一个基于 `Vue 3 + Vite` 的实时行情买点评估页面。

核心流程：

- 输入股票代码，例如 `AAPL`、`TSLA`、`0700.HK`、`600519.SS`
- 通过 Vite 代理获取 Yahoo Finance chart 行情
- 根据 MACD、EMA 趋势、成交量放大、止损距离动态评分
- 自动刷新行情并更新买点状态

## 本地运行

```bash
npm install
npm run dev
```

默认开发地址：

```text
http://localhost:5173
```

## 股票代码格式

常见 Yahoo Finance 代码示例：

```text
AAPL
TSLA
MSFT
0700.HK
600519.SS
000001.SZ
```

## 买点评估逻辑

页面会综合以下条件给出评分：

- `EMA` 快线是否高于慢线
- 价格是否站上关键均线
- `DIF` 是否上穿或接近 `DEA`
- `MACD` 柱是否增强
- 成交量是否超过均量阈值
- 当前价格对应的止损参考位

提示：该工具只做量化辅助评估，不构成投资建议。
