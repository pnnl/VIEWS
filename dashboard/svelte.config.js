import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
export default {
	kit: {
		adapter: adapter({
			// default options are shown. On some platforms
			// these options are set automatically — see below
			pages: 'build',
			assets: 'build',
			fallback: undefined,
			precompress: false,
			strict: true
		}),
		// GitHub Pages serves the site under /VIEWS (main) and /VIEWS/dev (develop).
		// The deploy workflow sets BASE_PATH per branch; production builds default to /VIEWS.
		paths: {
			base: process.env.BASE_PATH ?? (process.env.NODE_ENV === 'production' ? '/VIEWS' : '')
		}
	},
	preprocess: vitePreprocess(),
};




