import { useUserStore } from '@/stores/user';

export function getTheme(): 'light' | 'dark' {
	const userStore = useUserStore();

	if (!userStore.currentUser || !('theme' in userStore.currentUser) || userStore.currentUser.theme === 'auto') {
		if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
			return 'dark';
		}

		return 'light';
	}

	return userStore.currentUser.theme as 'light' | 'dark';
}
