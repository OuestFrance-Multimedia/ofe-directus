export const APP_SHARED_DEPS = ['@directus/extensions-sdk', 'vue', 'vue-router', 'vue-i18n', 'pinia'];
export const API_SHARED_DEPS = ['directus'];

export const APP_WITHOUT_HYBRID_EXTENSION_TYPES = ['interface', 'display', 'layout', 'module', 'panel'] as const;
export const API_WITHOUT_HYBRID_EXTENSION_TYPES = ['hook', 'endpoint', 'storage'] as const;
export const HYBRID_EXTENSION_TYPES = ['operation'] as const;
export const APP_EXTENSION_TYPES = [...APP_WITHOUT_HYBRID_EXTENSION_TYPES, ...HYBRID_EXTENSION_TYPES] as const;
export const API_EXTENSION_TYPES = [...API_WITHOUT_HYBRID_EXTENSION_TYPES, ...HYBRID_EXTENSION_TYPES] as const;
export const EXTENSION_TYPES = [
	...APP_WITHOUT_HYBRID_EXTENSION_TYPES,
	...API_WITHOUT_HYBRID_EXTENSION_TYPES,
	...HYBRID_EXTENSION_TYPES,
] as const;

export const PACK_EXTENSION_TYPE = 'pack';
export const APP_EXTENSION_PACKAGE_TYPES = [...APP_EXTENSION_TYPES, PACK_EXTENSION_TYPE] as const;
export const API_EXTENSION_PACKAGE_TYPES = [...API_EXTENSION_TYPES, PACK_EXTENSION_TYPE] as const;
export const EXTENSION_PACKAGE_TYPES = [...EXTENSION_TYPES, PACK_EXTENSION_TYPE] as const;

export const EXTENSION_LANGUAGES = ['javascript', 'typescript'] as const;

export const EXTENSION_NAME_REGEX = /^(?:(?:@[^/]+\/)?directus-extension-|@directus\/extension-).+$/;

export const EXTENSION_PKG_KEY = 'directus:extension';
