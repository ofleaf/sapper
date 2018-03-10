const path = require('path');
const assert = require('assert');
const Nightmare = require('nightmare');
const serve = require('serve-static');
const walkSync = require('walk-sync');
const fetch = require('node-fetch');
const rimraf = require('rimraf');
const ports = require('port-authority');

Nightmare.action('page', {
	title(done) {
		this.evaluate_now(() => document.querySelector('h1').textContent, done);
	},

	text(done) {
		this.evaluate_now(() => document.body.textContent, done);
	}
});

Nightmare.action('init', function(done) {
	this.evaluate_now(() => window.init(), done);
});

Nightmare.action('prefetchRoutes', function(done) {
	this.evaluate_now(() => window.prefetchRoutes(), done);
});

const cli = path.resolve(__dirname, '../../cli.js');

describe('sapper', function() {
	process.chdir(path.resolve(__dirname, '../app'));

	// clean up after previous test runs
	rimraf.sync('export');
	rimraf.sync('build');
	rimraf.sync('.sapper');

	this.timeout(30000);

	// TODO reinstate dev tests
	// run('development');
	run('production');

	describe('export', () => {
		before(() => {
			return exec(`node ${cli} export`);
		});

		it('export all pages', () => {
			const dest = path.resolve(__dirname, '../app/export');

			// Pages that should show up in the extraction directory.
			const expectedPages = [
				'index.html',
				'about/index.html',
				'slow-preload/index.html',

				'blog/index.html',
				'blog/a-very-long-post/index.html',
				'blog/how-can-i-get-involved/index.html',
				'blog/how-is-sapper-different-from-next/index.html',
				'blog/how-to-use-sapper/index.html',
				'blog/what-is-sapper/index.html',
				'blog/why-the-name/index.html',

				'blog.json',
				'blog/a-very-long-post.json',
				'blog/how-can-i-get-involved.json',
				'blog/how-is-sapper-different-from-next.json',
				'blog/how-to-use-sapper.json',
				'blog/what-is-sapper.json',
				'blog/why-the-name.json',

				'favicon.png',
				'global.css',
				'great-success.png',
				'manifest.json',
				'service-worker.js',
				'svelte-logo-192.png',
				'svelte-logo-512.png',
			];
			// Client scripts that should show up in the extraction directory.
			const expectedClientRegexes = [
				/client\/[^/]+\/_(\.\d+)?\.js/,
				/client\/[^/]+\/about(\.\d+)?\.js/,
				/client\/[^/]+\/blog_\$slug\$(\.\d+)?\.js/,
				/client\/[^/]+\/blog(\.\d+)?\.js/,
				/client\/[^/]+\/main(\.\d+)?\.js/,
				/client\/[^/]+\/show_url(\.\d+)?\.js/,
				/client\/[^/]+\/slow_preload(\.\d+)?\.js/,
			];
			const allPages = walkSync(dest);

			expectedPages.forEach((expectedPage) => {
				assert.ok(allPages.includes(expectedPage),`Could not find page matching ${expectedPage}`);
			});

			expectedClientRegexes.forEach((expectedRegex) => {
				// Ensure each client page regular expression matches at least one
				// generated page.
				let matched = false;
				for (const page of allPages) {
					if (expectedRegex.test(page)) {
						matched = true;
						break;
					}
				}
				assert.ok(matched, `Could not find client page matching ${expectedRegex}`);
			});
		});
	});
});

function run(env) {
	describe(`env=${env}`, function () {
		let proc;
		let nightmare;
		let capture;

		let base;

		before(() => {
			const promise = env === 'production'
				? exec(`node ${cli} build`).then(() => ports.find(3000))
				: ports.find(3000).then(port => {
					exec(`node ${cli} dev`);
					return ports.wait(port).then(() => port);
				});

			return promise.then(port => {
				base = `http://localhost:${port}`;

				const dir = env === 'production' ? 'build' : '.sapper';

				proc = require('child_process').fork(`${dir}/server.js`, {
					cwd: process.cwd(),
					env: {
						NODE_ENV: env,
						SAPPER_DEST: dir,
						PORT: port
					}
				});

				let handler;

				proc.on('message', message => {
					if (message.__sapper__) return;
					if (handler) handler(message);
				});

				capture = fn => {
					return new Promise((fulfil, reject) => {
						const captured = [];

						let start = Date.now();

						handler = message => {
							if (message.type === 'ready') {
								fn().then(() => {
									proc.send({
										action: 'end'
									});
								}, reject);
							}

							else if (message.type === 'done') {
								fulfil(captured);
								handler = null;
							}

							else {
								captured.push(message);
							}
						};

						proc.send({
							action: 'start'
						});
					});
				};
			});
		});

		after(() => {
			// give a chance to clean up
			return new Promise(fulfil => {
				proc.on('exit', fulfil);
				proc.kill();
			});
		});

		beforeEach(() => {
			nightmare = new Nightmare();

			nightmare.on('console', (type, ...args) => {
				console[type](...args);
			});

			nightmare.on('page', (type, ...args) => {
				if (type === 'error') {
					console.error(args[1]);
				} else {
					console.warn(type, args);
				}
			});
		});

		afterEach(() => {
			return nightmare.end();
		});

		describe('basic functionality', () => {
			it('serves /', () => {
				return nightmare.goto(base).page.title().then(title => {
					assert.equal(title, 'Great success!');
				});
			});

			it('serves /?', () => {
				return nightmare.goto(`${base}?`).page.title().then(title => {
					assert.equal(title, 'Great success!');
				});
			});

			it('serves static route', () => {
				return nightmare.goto(`${base}/about`).page.title().then(title => {
					assert.equal(title, 'About this site');
				});
			});

			it('serves dynamic route', () => {
				return nightmare.goto(`${base}/blog/what-is-sapper`).page.title().then(title => {
					assert.equal(title, 'What is Sapper?');
				});
			});

			it('navigates to a new page without reloading', () => {
				return capture(() => nightmare.goto(base).init().prefetchRoutes())
					.then(() => {
						return capture(() => nightmare.click('a[href="/about"]'));
					})
					.then(requests => {
						assert.deepEqual(requests.map(r => r.url), []);
						return nightmare.path();
					})
					.then(path => {
						assert.equal(path, '/about');
						return nightmare.title();
					})
					.then(title => {
						assert.equal(title, 'About');
					});
			});

			it('navigates programmatically', () => {
				return nightmare
					.goto(`${base}/about`)
					.init()
					.click('.goto')
					.wait(() => window.location.pathname === '/blog/what-is-sapper')
					.wait(100)
					.title()
					.then(title => {
						assert.equal(title, 'What is Sapper?');
					});
			});

			it('prefetches programmatically', () => {
				return nightmare
					.goto(`${base}/about`)
					.init()
					.then(() => {
						return capture(() => {
							return nightmare
								.click('.prefetch')
								.wait(200);
						});
					})
					.then(requests => {
						assert.ok(!!requests.find(r => r.url === '/blog/why-the-name.json'));
					});
			});

			it('scrolls to active deeplink', () => {
				return nightmare
					.goto(`${base}/blog/a-very-long-post#four`)
					.init()
					.evaluate(() => window.scrollY)
					.then(scrollY => {
						assert.ok(scrollY > 0, scrollY);
					});
			});

			it('reuses prefetch promise', () => {
				return nightmare
					.goto(`${base}/blog`)
					.init()
					.then(() => {
						return capture(() => {
							return nightmare
								.mouseover('[href="/blog/what-is-sapper"]')
								.wait(200);
						});
					})
					.then(mouseover_requests => {
						assert.ok(mouseover_requests.findIndex(r => r.url === '/blog/what-is-sapper.json') !== -1);

						return capture(() => {
							return nightmare
								.click('[href="/blog/what-is-sapper"]')
								.wait(200);
						});
					})
					.then(click_requests => {
						assert.ok(click_requests.findIndex(r => r.url === '/blog/what-is-sapper.json') === -1);
					});
			});

			it('cancels navigation if subsequent navigation occurs during preload', () => {
				return nightmare
					.goto(base)
					.init()
					.click('a[href="/slow-preload"]')
					.wait(100)
					.click('a[href="/about"]')
					.wait(100)
					.then(() => nightmare.path())
					.then(path => {
						assert.equal(path, '/about');
						return nightmare.title();
					})
					.then(title => {
						assert.equal(title, 'About');
						return nightmare.evaluate(() => window.fulfil({})).wait(100);
					})
					.then(() => nightmare.path())
					.then(path => {
						assert.equal(path, '/about');
						return nightmare.title();
					})
					.then(title => {
						assert.equal(title, 'About');
					});
			});

			it('passes entire request object to preload', () => {
				return nightmare
					.goto(`${base}/show-url`)
					.init()
					.evaluate(() => document.querySelector('p').innerHTML)
					.end().then(html => {
						assert.equal(html, `URL is /show-url`);
					});
			});

			it('calls a delete handler', () => {
				return nightmare
					.goto(`${base}/delete-test`)
					.init()
					.click('.del')
					.wait(() => window.deleted)
					.evaluate(() => window.deleted.id)
					.then(id => {
						assert.equal(id, 42);
					});
			});

			it('hydrates initial route', () => {
				return nightmare.goto(base)
					.wait('.hydrate-test')
					.evaluate(() => {
						window.el = document.querySelector('.hydrate-test');
					})
					.init()
					.evaluate(() => {
						return document.querySelector('.hydrate-test') === window.el;
					})
					.then(matches => {
						assert.ok(matches);
					});
			});

			it('redirects on server', () => {
				return nightmare.goto(`${base}/redirect-from`)
					.path()
					.then(path => {
						assert.equal(path, '/redirect-to');
					})
					.then(() => nightmare.page.title())
					.then(title => {
						assert.equal(title, 'redirected');
					});
			});

			it('redirects in client', () => {
				return nightmare.goto(base)
					.wait('[href="/redirect-from"]')
					.click('[href="/redirect-from"]')
					.wait(200)
					.path()
					.then(path => {
						assert.equal(path, '/redirect-to');
					})
					.then(() => nightmare.page.title())
					.then(title => {
						assert.equal(title, 'redirected');
					});
			});

			it('handles 4xx error on server', () => {
				return nightmare.goto(`${base}/blog/nope`)
					.path()
					.then(path => {
						assert.equal(path, '/blog/nope');
					})
					.then(() => nightmare.page.title())
					.then(title => {
						assert.equal(title, 'Not found')
					});
			});

			it('handles 4xx error in client', () => {
				return nightmare.goto(base)
					.init()
					.click('[href="/blog/nope"]')
					.wait(200)
					.path()
					.then(path => {
						assert.equal(path, '/blog/nope');
					})
					.then(() => nightmare.page.title())
					.then(title => {
						assert.equal(title, 'Not found');
					});
			});

			it('handles non-4xx error on server', () => {
				return nightmare.goto(`${base}/blog/throw-an-error`)
					.path()
					.then(path => {
						assert.equal(path, '/blog/throw-an-error');
					})
					.then(() => nightmare.page.title())
					.then(title => {
						assert.equal(title, 'Internal server error')
					});
			});

			it('handles non-4xx error in client', () => {
				return nightmare.goto(base)
					.init()
					.click('[href="/blog/throw-an-error"]')
					.wait(200)
					.path()
					.then(path => {
						assert.equal(path, '/blog/throw-an-error');
					})
					.then(() => nightmare.page.title())
					.then(title => {
						assert.equal(title, 'Internal server error');
					});
			});

			it('does not attempt client-side navigation to server routes', () => {
				return nightmare.goto(`${base}/blog/how-is-sapper-different-from-next`)
					.init()
					.click(`[href="/blog/how-is-sapper-different-from-next.json"]`)
					.wait(200)
					.page.text()
					.then(text => {
						JSON.parse(text);
					});
			});

			it('does not serve error page for non-page errors', () => {
				return nightmare.goto(`${base}/throw-an-error`)
					.page.text()
					.then(text => {
						assert.equal(text, 'nope');
					});
			});

			it('encodes routes', () => {
				return nightmare.goto(`${base}/fünke`)
					.page.title()
					.then(title => {
						assert.equal(title, `I'm afraid I just blue myself`);
					});
			});
		});

		describe('headers', () => {
			it('sets Content-Type and Link...preload headers', () => {
				return capture(() => nightmare.goto(base).end()).then(requests => {
					const { headers } = requests[0];

					assert.equal(
						headers['content-type'],
						'text/html'
					);

					assert.ok(
						/<\/client\/[^/]+\/main\.js>;rel="preload";as="script", <\/client\/[^/]+\/_\.\d+\.js>;rel="preload";as="script"/.test(headers['link']),
						headers['link']
					);
				});
			});
		});
	});
}

function exec(cmd) {
	return new Promise((fulfil, reject) => {
		const parts = cmd.split(' ');
		const proc = require('child_process').spawn(parts.shift(), parts);

		proc.stdout.on('data', data => {
			process.stdout.write(data);
		});

		proc.stderr.on('data', data => {
			process.stderr.write(data);
		});

		proc.on('error', reject);

		proc.on('close', () => fulfil());
	});
}
