import { notFound } from "next/navigation";
import * as root from "next/root-params";
import { isSupportedLanguage } from "./languages";

export const getRootLang = async () => {
  const lang = await root.lang();
  return lang && isSupportedLanguage(lang) ? lang : notFound();
};
