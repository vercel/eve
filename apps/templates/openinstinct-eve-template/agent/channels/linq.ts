import { connectLinqCredentials } from "@vercel/connect/eve";
import { linqChannel } from "eve/channels/linq";

export default linqChannel({
  credentials: connectLinqCredentials(process.env.LINQ_CONNECTOR ?? "linq/open-instinct"),
  userName: "OpenInstinct",
});
