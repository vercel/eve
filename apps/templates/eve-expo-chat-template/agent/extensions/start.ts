import start from "@eve-start/eve";
export default start({
  password: process.env.EVE_APP_PASSWORD,
  databaseUrl: process.env.DATABASE_URL,
});
