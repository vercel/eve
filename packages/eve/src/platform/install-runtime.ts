import { createPlatform, DEFAULT_PLATFORM_TARGET } from "#platform/create.js";
import { installPlatform } from "#platform/current.js";

installPlatform(createPlatform(DEFAULT_PLATFORM_TARGET));
