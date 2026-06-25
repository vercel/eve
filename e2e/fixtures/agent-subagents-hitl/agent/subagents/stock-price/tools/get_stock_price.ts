import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

const MOCK_PRICES: Record<string, { price: number; change: number }> = {
  AAPL: { price: 227.34, change: 1.25 },
  GOOG: { price: 178.92, change: -0.43 },
  MSFT: { price: 442.57, change: 2.18 },
  TSLA: { price: 248.91, change: -3.67 },
  AMZN: { price: 198.43, change: 0.82 },
  NVDA: { price: 131.28, change: 4.56 },
};

export default defineTool({
  description: "Get the current stock price for a ticker symbol.",
  inputSchema: z.object({
    ticker: z.string().describe("Stock ticker symbol"),
  }),
  approval: once(),
  async execute(input) {
    const ticker = input.ticker.toUpperCase();
    const data = MOCK_PRICES[ticker];

    if (!data) {
      return {
        ticker,
        error: `No price data available for ${ticker}.`,
      };
    }

    return {
      ticker,
      price: data.price,
      change: data.change,
      changePercent: `${data.change >= 0 ? "+" : ""}${((data.change / data.price) * 100).toFixed(2)}%`,
      currency: "USD",
    };
  },
});
