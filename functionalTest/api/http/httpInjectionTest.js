'use strict';

var assert = require('assert'),
    spawn = require('child_process').spawn,
    path = require('path'),
    api = require('../api'),
    BaseHttpClient = require('./baseHttpClient'),
    Q = require('q'),
    promiseIt = require('../../testHelpers').promiseIt,
    port = api.port + 1,
    timeout = parseInt(process.env.SLOW_TEST_TIMEOUT_MS || 3000);

function nonInjectableServer (command, port) {
    var deferred = Q.defer(),
        calledDone = false,
        mbPath = path.normalize(__dirname + '/../../../bin/mb'),
        mb = spawn(mbPath, [command, '--port', port, '--pidfile', 'imposter-test.pid']);

    ['stdout', 'stderr'].forEach(function (stream) {
        mb[stream].on('data', function () {
            if (!calledDone) {
                calledDone = true;
                deferred.resolve();
            }
        });
    });
    return deferred.promise;
}

['http', 'https'].forEach(function (protocol) {
    var client = BaseHttpClient.create(protocol);

    describe(protocol + ' imposter', function () {
        this.timeout(timeout);

        describe('POST /imposters with injections', function () {
            promiseIt('should allow javascript predicate for matching', function () {
                // note the lower-case keys for headers!!!
                var stub = {
                        predicates: [{ inject: "function (request) { return request.path === '/test'; }" }],
                        responses: [{ is: { body: 'MATCHED' } }]
                    },
                    request = { protocol: protocol, port: port, stubs: [stub], name: this.name };

                return api.post('/imposters', request).then(function (response) {
                    assert.strictEqual(response.statusCode, 201, JSON.stringify(response.body));

                    var spec = {
                        path: '/test?key=value',
                        port: port,
                        method: 'POST',
                        headers: {
                            'X-Test': 'test header',
                            'Content-Type': 'text/plain'
                        }
                    };
                    return client.responseFor(spec, 'BODY');
                }).then(function (response) {
                    assert.strictEqual(response.body, 'MATCHED');
                }).finally(function () {
                    return api.del('/imposters');
                });
            });

            promiseIt('should give a 400 on a bad predicate injection', function () {
                var stub = {
                        predicates: [{ inject: 'return true;' }],
                        responses: [{ is: { body: 'MATCHED' } }]
                    },
                    request = { protocol: protocol, port: port, stubs: [stub], name: this.name };

                return api.post('/imposters', request).then(function (response) {
                    assert.strictEqual(response.statusCode, 400, JSON.stringify(response.body));
                    assert.strictEqual(response.body.errors[0].data, 'invalid predicate injection');
                }).finally(function () {
                    return api.del('/imposters');
                });
            });

            promiseIt('should allow synchronous javascript injection for responses', function () {
                var fn = "function (request) { return { body: request.method + ' INJECTED' }; }",
                    stub = { responses: [{ inject: fn }] },
                    request = { protocol: protocol, port: port, stubs: [stub], name: this.name };

                return api.post('/imposters', request).then(function () {
                    return client.get('/', port);
                }).then(function (response) {
                    assert.strictEqual(response.body, 'GET INJECTED');
                    assert.strictEqual(response.statusCode, 200);
                    assert.strictEqual(response.headers.connection, 'close');
                }).finally(function () {
                    return api.del('/imposters');
                });
            });

            promiseIt('should give a 400 on a bad response injection', function () {
                var fn = "function () { throw('BOOM'); }",
                    stub = { responses: [{ inject: fn }] },
                    request = { protocol: protocol, port: port, stubs: [stub], name: this.name };

                return api.post('/imposters', request).then(function (response) {
                    assert.strictEqual(response.statusCode, 400, JSON.stringify(response.body));
                    assert.strictEqual(response.body.errors[0].message, 'invalid response injection');
                }).finally(function () {
                    return api.del('/imposters');
                });
            });

            promiseIt('should allow javascript injection to keep state between requests', function () {
                var fn = "function (request, state) {\n" +
                        "    if (!state.calls) { state.calls = 0; }\n" +
                        "    state.calls += 1;\n" +
                        "    return { body: state.calls.toString() };\n" +
                        "}",
                    stub = { responses: [{ inject: fn }] },
                    request = { protocol: protocol, port: port, stubs: [stub], name: this.name };

                return api.post('/imposters', request).then(function (response) {
                    assert.strictEqual(response.statusCode, 201, JSON.stringify(response.body));

                    return client.get('/', port);
                }).then(function (response) {
                    assert.strictEqual(response.body, '1');

                    return client.get('/', port);
                }).then(function (response) {
                    assert.deepEqual(response.body, '2');
                }).finally(function () {
                    return api.del('/imposters');
                });
            });

            promiseIt('should return a 400 if injection is disallowed and inject is used', function () {
                var mbPort = port + 1,
                    fn = "function (request) { return { body: request.method + ' INJECTED' }; }",
                    stub = { responses: [{ inject: fn }] },
                    request = { protocol: protocol, port: port, stubs: [stub], name: this.name },
                    mbApi = BaseHttpClient.create('http');

                return nonInjectableServer('start', mbPort).then(function () {
                    return mbApi.post('/imposters', request, mbPort);
                }).then(function (response) {
                    assert.strictEqual(response.statusCode, 400);
                    assert.strictEqual(response.body.errors[0].code, 'invalid injection');
                }).finally(function () {
                    return nonInjectableServer('stop', mbPort);
                });
            });

            promiseIt('should allow asynchronous injection', function () {
                var fn = "function (request, state, logger, callback) {\n" +
                        "    var http = require('http'),\n" +
                        "        options = {\n" +
                        "            method: request.method,\n" +
                        "            hostname: 'www.google.com',\n" +
                        "            port: 80,\n" +
                        "            path: request.path,\n" +
                        "            headers: request.headers\n" +
                        "        },\n" +
                        "        httpRequest = http.request(options, function (response) {\n" +
                        "            response.body = '';\n" +
                        "            response.setEncoding('utf8');\n" +
                        "            response.on('data', function (chunk) {\n" +
                        "                response.body += chunk;\n" +
                        "            });\n" +
                        "            response.on('end', function () {\n" +
                        "                callback({\n" +
                        "                    statusCode: response.statusCode,\n" +
                        "                    headers: response.headers,\n" +
                        "                    body: response.body\n" +
                        "                });\n" +
                        "            });\n" +
                        "        });\n" +
                        "    httpRequest.end();\n" +
                        "    // No return value!!!\n" +
                        "}",
                    stub = { responses: [{ inject: fn }] },
                    request = { protocol: protocol, port: port, stubs: [stub], name: this.name };

                return api.post('/imposters', request).then(function (response) {
                    assert.strictEqual(response.statusCode, 201, JSON.stringify(response.body));

                    return client.get('', port);
                }).then(function (response) {
                    assert.strictEqual(response.statusCode, 302);
                    assert.strictEqual(response.headers.location, 'http://www.google.com/');
                }).finally(function () {
                    return api.del('/imposters');
                });
            });
        });
    });
});
