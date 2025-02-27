import express, { Router } from 'express';
import path from 'path';
import {
	ActionHandler,
	ApiExtension,
	AppExtensionType,
	EndpointConfig,
	Extension,
	ExtensionType,
	FilterHandler,
	HookConfig,
	HybridExtension,
	InitHandler,
	OperationApiConfig,
	ScheduleHandler,
} from '@directus/shared/types';
import {
	ensureExtensionDirs,
	generateExtensionsEntry,
	getLocalExtensions,
	getPackageExtensions,
	resolvePackage,
} from '@directus/shared/utils/node';
import {
	API_EXTENSION_PACKAGE_TYPES,
	API_EXTENSION_TYPES,
	APP_EXTENSION_TYPES,
	APP_SHARED_DEPS,
	EXTENSION_PACKAGE_TYPES,
	EXTENSION_TYPES,
	HYBRID_EXTENSION_TYPES,
	PACK_EXTENSION_TYPE,
} from '@directus/shared/constants';
import getDatabase from './database';
import emitter, { Emitter } from './emitter';
import env from './env';
import * as exceptions from './exceptions';
import * as sharedExceptions from '@directus/shared/exceptions';
import logger from './logger';
import fse from 'fs-extra';
import { getSchema } from './utils/get-schema';

import * as services from './services';
import { schedule, validate } from 'node-cron';
import { rollup } from 'rollup';
import virtual from '@rollup/plugin-virtual';
import alias from '@rollup/plugin-alias';
import { Url } from './utils/url';
import getModuleDefault from './utils/get-module-default';
import { clone, escapeRegExp } from 'lodash';
import chokidar, { FSWatcher } from 'chokidar';
import { isExtensionObject, isHybridExtension, pluralize } from '@directus/shared/utils';
import { getFlowManager } from './flows';
import globby from 'globby';
import { EventHandler } from './types';
import { JobQueue } from './utils/job-queue';
import { StorageConfig } from '@directus/shared/types';

let extensionManager: ExtensionManager | undefined;

export function getExtensionManager(): ExtensionManager {
	if (extensionManager) {
		return extensionManager;
	}

	extensionManager = new ExtensionManager();

	return extensionManager;
}

type AppExtensions = Partial<Record<AppExtensionType, string>>;
type ApiExtensions = {
	hooks: { path: string; events: EventHandler[] }[];
	endpoints: { path: string }[];
	storages: { path: string; config: StorageConfig }[];
	operations: { path: string }[];
};

type Options = {
	schedule: boolean;
	watch: boolean;
};

const defaultOptions: Options = {
	schedule: true,
	watch: env.EXTENSIONS_AUTO_RELOAD && env.NODE_ENV !== 'development',
};

class ExtensionManager {
	private isLoaded = false;
	private options: Options;

	private extensions: Extension[] = [];

	private appExtensions: AppExtensions = {};
	private apiExtensions: ApiExtensions = { hooks: [], endpoints: [], storages: [], operations: [] };

	private apiEmitter: Emitter;
	private endpointRouter: Router;

	private reloadQueue: JobQueue;
	private watcher: FSWatcher | null = null;

	constructor() {
		this.options = defaultOptions;

		this.apiEmitter = new Emitter();
		this.endpointRouter = Router();

		this.reloadQueue = new JobQueue();
	}

	public async initialize(options: Partial<Options> = {}): Promise<void> {
		this.options = {
			...defaultOptions,
			...options,
		};

		this.initializeWatcher();

		if (!this.isLoaded) {
			await this.load();

			this.updateWatchedExtensions(this.extensions);

			const loadedExtensions = this.getExtensionsList();
			if (loadedExtensions.length > 0) {
				logger.info(`Loaded extensions: ${loadedExtensions.join(', ')}`);
			}
		}
	}

	public reload(): void {
		this.reloadQueue.enqueue(async () => {
			if (this.isLoaded) {
				logger.info('Reloading extensions');

				const prevExtensions = clone(this.extensions);

				await this.unload();
				await this.load();

				const added = this.extensions.filter(
					(extension) => !prevExtensions.some((prevExtension) => extension.path === prevExtension.path)
				);
				const removed = prevExtensions.filter(
					(prevExtension) => !this.extensions.some((extension) => prevExtension.path === extension.path)
				);

				this.updateWatchedExtensions(added, removed);

				const addedExtensions = added.map((extension) => extension.name);
				const removedExtensions = removed.map((extension) => extension.name);
				if (addedExtensions.length > 0) {
					logger.info(`Added extensions: ${addedExtensions.join(', ')}`);
				}
				if (removedExtensions.length > 0) {
					logger.info(`Removed extensions: ${removedExtensions.join(', ')}`);
				}
			} else {
				logger.warn('Extensions have to be loaded before they can be reloaded');
			}
		});
	}

	public getExtensionsList(type?: ExtensionType): string[] {
		if (type === undefined) {
			return this.extensions.map((extension) => extension.name);
		} else {
			return this.extensions.filter((extension) => extension.type === type).map((extension) => extension.name);
		}
	}

	public getAppExtensions(type: AppExtensionType): string | undefined {
		return this.appExtensions[type];
	}

	public getApiExtensions(): ApiExtensions {
		return this.apiExtensions;
	}

	public getEndpointRouter(): Router {
		return this.endpointRouter;
	}

	private async load(): Promise<void> {
		try {
			await ensureExtensionDirs(env.EXTENSIONS_PATH, env.SERVE_APP ? EXTENSION_TYPES : API_EXTENSION_TYPES);

			this.extensions = await this.getExtensions();
		} catch (err: any) {
			logger.warn(`Couldn't load extensions`);
			logger.warn(err);
		}

		this.registerHooks();
		this.registerEndpoints();
		this.registerStorages();
		await this.registerOperations();

		if (env.SERVE_APP) {
			this.appExtensions = await this.generateExtensionBundles();
		}

		this.isLoaded = true;
	}

	private async unload(): Promise<void> {
		this.unregisterHooks();
		this.unregisterEndpoints();
		this.unregisterStorages();
		this.unregisterOperations();

		this.apiEmitter.offAll();

		if (env.SERVE_APP) {
			this.appExtensions = {};
		}

		this.isLoaded = false;
	}

	private initializeWatcher(): void {
		if (this.options.watch && !this.watcher) {
			logger.info('Watching extensions for changes...');

			const localExtensionPaths = (env.SERVE_APP ? EXTENSION_TYPES : API_EXTENSION_TYPES).flatMap((type) => {
				const typeDir = path.posix.join(
					path.relative('.', env.EXTENSIONS_PATH).split(path.sep).join(path.posix.sep),
					pluralize(type)
				);

				return isHybridExtension(type)
					? [path.posix.join(typeDir, '*', 'app.js'), path.posix.join(typeDir, '*', 'api.js')]
					: path.posix.join(typeDir, '*', 'index.js');
			});

			this.watcher = chokidar.watch([path.resolve('package.json'), ...localExtensionPaths], {
				ignoreInitial: true,
			});

			this.watcher
				.on('add', () => this.reload())
				.on('change', () => this.reload())
				.on('unlink', () => this.reload());
		}
	}

	private updateWatchedExtensions(added: Extension[], removed: Extension[] = []): void {
		if (this.watcher) {
			const toPackageExtensionPaths = (extensions: Extension[]) =>
				extensions
					.filter((extension) => !extension.local)
					.flatMap((extension) =>
						extension.type === PACK_EXTENSION_TYPE
							? path.resolve(extension.path, 'package.json')
							: isExtensionObject(extension, HYBRID_EXTENSION_TYPES)
							? [
									path.resolve(extension.path, extension.entrypoint.app),
									path.resolve(extension.path, extension.entrypoint.api),
							  ]
							: path.resolve(extension.path, extension.entrypoint)
					);

			const addedPackageExtensionPaths = toPackageExtensionPaths(added);
			const removedPackageExtensionPaths = toPackageExtensionPaths(removed);

			this.watcher.add(addedPackageExtensionPaths);
			this.watcher.unwatch(removedPackageExtensionPaths);
		}
	}

	private async getExtensions(): Promise<Extension[]> {
		const packageExtensions = await getPackageExtensions(
			'.',
			env.SERVE_APP ? EXTENSION_PACKAGE_TYPES : API_EXTENSION_PACKAGE_TYPES
		);
		const localExtensions = await getLocalExtensions(
			env.EXTENSIONS_PATH,
			env.SERVE_APP ? EXTENSION_TYPES : API_EXTENSION_TYPES
		);

		return [...packageExtensions, ...localExtensions];
	}

	private async generateExtensionBundles() {
		const sharedDepsMapping = await this.getSharedDepsMapping(APP_SHARED_DEPS);
		const internalImports = Object.entries(sharedDepsMapping).map(([name, path]) => ({
			find: name,
			replacement: path,
		}));

		const bundles: Partial<Record<AppExtensionType, string>> = {};

		for (const extensionType of APP_EXTENSION_TYPES) {
			const entry = generateExtensionsEntry(extensionType, this.extensions);

			try {
				const bundle = await rollup({
					input: 'entry',
					external: Object.values(sharedDepsMapping),
					makeAbsoluteExternalsRelative: false,
					plugins: [virtual({ entry }), alias({ entries: internalImports })],
				});
				const { output } = await bundle.generate({ format: 'es', compact: true });

				bundles[extensionType] = output[0].code;

				await bundle.close();
			} catch (error: any) {
				logger.warn(`Couldn't bundle App extensions`);
				logger.warn(error);
			}
		}

		return bundles;
	}

	private async getSharedDepsMapping(deps: string[]) {
		const appDir = await fse.readdir(path.join(resolvePackage('@directus/app'), 'dist', 'assets'));

		const depsMapping: Record<string, string> = {};
		for (const dep of deps) {
			const depRegex = new RegExp(`${escapeRegExp(dep.replace(/\//g, '_'))}\\.[0-9a-f]{8}\\.entry\\.js`);
			const depName = appDir.find((file) => depRegex.test(file));

			if (depName) {
				const depUrl = new Url(env.PUBLIC_URL).addPath('admin', 'assets', depName);

				depsMapping[dep] = depUrl.toString({ rootRelative: true });
			} else {
				logger.warn(`Couldn't find shared extension dependency "${dep}"`);
			}
		}

		return depsMapping;
	}

	private registerHooks(): void {
		const hooks = this.extensions.filter((extension): extension is ApiExtension => extension.type === 'hook');

		for (const hook of hooks) {
			try {
				const hookPath = path.resolve(hook.path, hook.entrypoint);
				const hookInstance: HookConfig | { default: HookConfig } = require(hookPath);

				const config = getModuleDefault(hookInstance);

				this.registerHook(config, hookPath);
			} catch (error: any) {
				logger.warn(`Couldn't register hook "${hook.name}"`);
				logger.warn(error);
			}
		}
	}

	private registerEndpoints(): void {
		const endpoints = this.extensions.filter((extension): extension is ApiExtension => extension.type === 'endpoint');

		for (const endpoint of endpoints) {
			try {
				const endpointPath = path.resolve(endpoint.path, endpoint.entrypoint);
				const endpointInstance: EndpointConfig | { default: EndpointConfig } = require(endpointPath);

				const config = getModuleDefault(endpointInstance);

				this.registerEndpoint(config, endpointPath, endpoint.name, this.endpointRouter);
			} catch (error: any) {
				logger.warn(`Couldn't register endpoint "${endpoint.name}"`);
				logger.warn(error);
			}
		}
	}

	registerStorages() {
		const storages = this.extensions.filter((extension): extension is ApiExtension => extension.type === 'storage');
		for (const storage of storages) {
			try {
				const storagePath = path.resolve(storage.path, storage.entrypoint);
				this.apiExtensions.storages.push({
					path: storagePath,
					config: require(storagePath),
				});
			} catch (error: any) {
				logger.warn(`Couldn't register storage "${storage.name}"`);
				logger.warn(error);
			}
		}
	}

	private async registerOperations(): Promise<void> {
		const internalPaths = await globby(
			path.posix.join(path.relative('.', __dirname).split(path.sep).join(path.posix.sep), 'operations/*/index.(js|ts)')
		);

		const internalOperations = internalPaths.map((internalPath) => {
			const dirs = internalPath.split(path.sep);

			return {
				name: dirs[dirs.length - 2],
				path: dirs.slice(0, -1).join(path.sep),
				entrypoint: { api: dirs[dirs.length - 1] },
			};
		});

		const operations = this.extensions.filter(
			(extension): extension is HybridExtension => extension.type === 'operation'
		);

		for (const operation of [...internalOperations, ...operations]) {
			try {
				const operationPath = path.resolve(operation.path, operation.entrypoint.api);
				const operationInstance: OperationApiConfig | { default: OperationApiConfig } = require(operationPath);

				const config = getModuleDefault(operationInstance);

				this.registerOperation(config, operationPath);
			} catch (error: any) {
				logger.warn(`Couldn't register operation "${operation.name}"`);
				logger.warn(error);
			}
		}
	}

	private registerHook(register: HookConfig, path: string) {
		const hookHandler: { path: string; events: EventHandler[] } = {
			path,
			events: [],
		};

		const registerFunctions = {
			filter: (event: string, handler: FilterHandler) => {
				emitter.onFilter(event, handler);

				hookHandler.events.push({
					type: 'filter',
					name: event,
					handler,
				});
			},
			action: (event: string, handler: ActionHandler) => {
				emitter.onAction(event, handler);

				hookHandler.events.push({
					type: 'action',
					name: event,
					handler,
				});
			},
			init: (event: string, handler: InitHandler) => {
				emitter.onInit(event, handler);

				hookHandler.events.push({
					type: 'init',
					name: event,
					handler,
				});
			},
			schedule: (cron: string, handler: ScheduleHandler) => {
				if (validate(cron)) {
					const task = schedule(cron, async () => {
						if (this.options.schedule) {
							try {
								await handler();
							} catch (error: any) {
								logger.error(error);
							}
						}
					});

					hookHandler.events.push({
						type: 'schedule',
						task,
					});
				} else {
					logger.warn(`Couldn't register cron hook. Provided cron is invalid: ${cron}`);
				}
			},
		};

		register(registerFunctions, {
			services,
			exceptions: { ...exceptions, ...sharedExceptions },
			env,
			database: getDatabase(),
			emitter: this.apiEmitter,
			logger,
			getSchema,
		});

		this.apiExtensions.hooks.push(hookHandler);
	}

	private registerEndpoint(config: EndpointConfig, path: string, name: string, router: Router) {
		const register = typeof config === 'function' ? config : config.handler;
		const routeName = typeof config === 'function' ? name : config.id;

		const scopedRouter = express.Router();
		router.use(`/${routeName}`, scopedRouter);

		register(scopedRouter, {
			services,
			exceptions: { ...exceptions, ...sharedExceptions },
			env,
			database: getDatabase(),
			emitter: this.apiEmitter,
			logger,
			getSchema,
		});

		this.apiExtensions.endpoints.push({
			path,
		});
	}

	private registerOperation(config: OperationApiConfig, path: string) {
		const flowManager = getFlowManager();

		flowManager.addOperation(config.id, config.handler);

		this.apiExtensions.operations.push({
			path,
		});
	}

	private unregisterHooks(): void {
		for (const hook of this.apiExtensions.hooks) {
			for (const event of hook.events) {
				switch (event.type) {
					case 'filter':
						emitter.offFilter(event.name, event.handler);
						break;
					case 'action':
						emitter.offAction(event.name, event.handler);
						break;
					case 'init':
						emitter.offInit(event.name, event.handler);
						break;
					case 'schedule':
						event.task.stop();
						break;
				}
			}

			delete require.cache[require.resolve(hook.path)];
		}

		this.apiExtensions.hooks = [];
	}

	private unregisterEndpoints(): void {
		for (const endpoint of this.apiExtensions.endpoints) {
			delete require.cache[require.resolve(endpoint.path)];
		}

		this.endpointRouter.stack = [];

		this.apiExtensions.endpoints = [];
	}

	unregisterStorages() {
		for (const storage of this.apiExtensions.storages) {
			delete require.cache[require.resolve(storage.path)];
		}
		this.apiExtensions.storages = [];
	}

	private unregisterOperations(): void {
		for (const operation of this.apiExtensions.operations) {
			delete require.cache[require.resolve(operation.path)];
		}

		const flowManager = getFlowManager();

		flowManager.clearOperations();

		this.apiExtensions.operations = [];
	}
}
