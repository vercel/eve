export const translations = {
  en: {
    displayName: "English",
  },
};

export const supportedLanguages = Object.freeze(Object.keys(translations));

export const isSupportedLanguage = (language: string): language is keyof typeof translations =>
  Object.hasOwn(translations, language);
