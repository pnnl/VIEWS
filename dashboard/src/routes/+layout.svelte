<script>
	import '../app.css';
	// this variable will be important if deploying to a non-root url,
	// such as with github pages when you don't have a custom domain;
	// defined in `svelte.config.js`
	import { base } from '$app/paths';
	import { Navbar, NavBrand, NavLi, NavUl, NavHamburger } from 'flowbite-svelte';
	const nav_items = ['Energy-Water Flows for the United States over the 21st Century'];
	const page_items = ['sankeys', 'methodology',  'data', 'resources', 'acknowledgments', 'disclaimer'];

	import Icon from "@iconify/svelte";

	// The develop branch deploys to /VIEWS/dev with VITE_DEPLOY_CHANNEL=preview.
	// The banner and noindex keep the preview distinguishable from the release site.
	const isPreview = import.meta.env.VITE_DEPLOY_CHANNEL === 'preview';
	const commitSha = (import.meta.env.VITE_COMMIT_SHA ?? '').slice(0, 7);
</script>

<svelte:head>
	{#if isPreview}
		<meta name="robots" content="noindex" />
	{/if}
</svelte:head>

{#if isPreview}
	<div class="flex w-screen items-center justify-center gap-2 bg-amber-100 py-1 text-sm text-amber-900 border-b border-amber-300">
		<Icon icon="tabler:flask" />
		<span>Preview build of the <strong>develop</strong> branch{commitSha ? ` (${commitSha})` : ''}. Results may change.</span>
		<a href="/VIEWS/" class="underline hover:text-amber-700">Go to the released dashboard</a>
	</div>
{/if}

<div class="flex flex-row w-screen font-sans h-[120px] pl-8  bg-gradient-to-r from-[#2B7F9E] to-[#5e1f04] items-center gap-8 text-white text-3xl">

	<a href="{base}/">Integrated Energy-Water Flows for the United States over the 21st Century</a>
	<img src="{base}/PNNLVerticalLogo.png" alt="PNNL logo" class='h-[100px] ml-auto pr-7'/>

</div>

<div class="flex flex-row w-screen font-sans h-auto pl-8 bg-none items-center gap-8 text-gray-800 rounded-s text-gray-700 border-2">

	{#each page_items as item}
	<a href="{base}/{item === 'sankeys' ? '' : item}" class="hover:text-[#2B7F9E] hover:scale-105">{item.toUpperCase()}</a>
	
</div>

<div class="flex flex-row w-screen h-[20px] pl-8  bg-white gap-8">	


</div>




<slot></slot>
