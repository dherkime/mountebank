'use strict';

var assert = require('assert'),
    api = require('../api'),
    client = require('./baseHttpClient').create('http'),
    promiseIt = require('../../testHelpers').promiseIt,
    port = api.port + 1,
    timeout = parseInt(process.env.SLOW_TEST_TIMEOUT_MS || 2000);

describe('http proxy stubs', function () {
    this.timeout(timeout);

    promiseIt('should allow proxy stubs to invalid domains', function () {
        var stub = { responses: [{ proxy: { to: 'http://invalid.domain' } }] },
            request = { protocol: 'http', port: port, stubs: [stub], name: this.name };

        return api.post('/imposters', request).then(function () {
            return client.get('/', port);
        }).then(function (response) {
            assert.strictEqual(response.statusCode, 500);
            assert.strictEqual(response.body.errors[0].code, 'invalid proxy');
            assert.strictEqual(response.body.errors[0].message, 'Cannot resolve "http://invalid.domain"');
        }).finally(function () {
            return api.del('/imposters');
        });
    });

    promiseIt('should reflect default mode after first proxy if no mode passed in', function () {
        var originServerPort = port + 1,
            originServerStub = { responses: [{ is: { body: 'origin server' } }] },
            originServerRequest = { protocol: 'http', port: originServerPort, stubs: [originServerStub], name: this.name + ' origin' },
            proxyStub = { responses: [{ proxy: { to: 'http://localhost:' + originServerPort } }] },
            proxyRequest = { protocol: 'http', port: port, stubs: [proxyStub], name: this.name + ' proxy' };

        return api.post('/imposters', originServerRequest).then(function () {
            return api.post('/imposters', proxyRequest);
        }).then(function (response) {
            assert.strictEqual(response.statusCode, 201, JSON.stringify(response.body, null, 2));
            return client.get('/', port);
        }).then(function (response) {
            assert.strictEqual(response.body, 'origin server');
            return api.get('/imposters/' + port);
        }).then(function (response) {
            assert.strictEqual(response.body.stubs[1].responses[0].proxy.mode, 'proxyOnce');
        }).finally(function () {
            return api.del('/imposters' );
        });
    });

    promiseIt('should record new stubs in order in front of proxy resolver using proxyOnce mode', function () {
        var originServerPort = port + 1,
            originServerFn = 'function (request, state) {\n' +
                             '    state.count = state.count || 0;\n' +
                             '    state.count += 1;\n' +
                             '    return {\n' +
                             '        body: state.count + ". " + request.method + " " + request.path\n' +
                             '    };\n' +
                             '}',
            originServerStub = { responses: [{ inject: originServerFn }] },
            originServerRequest = {
                protocol: 'http',
                port: originServerPort,
                stubs: [originServerStub],
                name: this.name + ' origin server'
            },
            proxyDefinition = {
                to: 'http://localhost:' + originServerPort,
                mode: 'proxyOnce',
                predicateGenerators: [
                    {
                        matches: {
                            method: true,
                            path: true
                        }
                    }
                ]
            },
            proxyStub = { responses: [{ proxy: proxyDefinition }] },
            proxyRequest = { protocol: 'http', port: port, stubs: [proxyStub], name: this.name + ' proxy' };

        return api.post('/imposters', originServerRequest).then(function () {
            return api.post('/imposters', proxyRequest);
        }).then(function (response) {
            assert.strictEqual(response.statusCode, 201, JSON.stringify(response.body, null, 2));
            return client.get('/first', port);
        }).then(function (response) {
            assert.strictEqual(response.body, '1. GET /first');
            return client.del('/first', port);
        }).then(function (response) {
            assert.strictEqual(response.body, '2. DELETE /first');
            return client.get('/second', port);
        }).then(function (response) {
            assert.strictEqual(response.body, '3. GET /second');
            return client.get('/first', port);
        }).then(function (response) {
            assert.strictEqual(response.body, '1. GET /first');
            return client.del('/first', port);
        }).then(function (response) {
            assert.strictEqual(response.body, '2. DELETE /first');
            return client.get('/second', port);
        }).then(function (response) {
            assert.strictEqual(response.body, '3. GET /second');
            return api.del('/imposters/' + port);
        }).then(function (response) {
            assert.strictEqual(response.body.stubs.length, 4);
        }).finally(function () {
            return api.del('/imposters');
        });
    });

    promiseIt('should record new stubs with multiple responses behind proxy resolver in proxyAlways mode', function () {
        var originServerPort = port + 1,
            originServerFn = 'function (request, state) {\n' +
                             '    state.count = state.count || 0;\n' +
                             '    state.count += 1;\n' +
                             '    return {\n' +
                             '        body: state.count + ". " + request.path\n' +
                             '    };\n' +
                             '}',
            originServerStub = { responses: [{ inject: originServerFn }] },
            originServerRequest = {
                protocol: 'http',
                port: originServerPort,
                stubs: [originServerStub],
                name: this.name + ' origin server'
            },
            proxyDefinition = {
                to: 'http://localhost:' + originServerPort,
                mode: 'proxyAlways',
                predicateGenerators: [{ matches: { path: true } }]
            },
            proxyStub = { responses: [{ proxy: proxyDefinition }] },
            proxyRequest = { protocol: 'http', port: port, stubs: [proxyStub], name: this.name + ' proxy' };

        return api.post('/imposters', originServerRequest).then(function () {
            return api.post('/imposters', proxyRequest);
        }).then(function (response) {
            assert.strictEqual(response.statusCode, 201, JSON.stringify(response.body));
            return client.get('/first', port);
        }).then(function () {
            return client.get('/second', port);
        }).then(function () {
            return client.get('/first', port);
        }).then(function () {
            return api.del('/imposters/' + port);
        }).then(function (response) {
            assert.strictEqual(response.body.stubs.length, 3);

            var stubs = response.body.stubs,
                responses = stubs.splice(1).map(function (stub) {
                    return stub.responses.map(function (response) { return response.is.body; });
                });

            assert.deepEqual(responses, [['1. /first', '3. /first'], ['2. /second']]);
        }).finally(function () {
            return api.del('/imposters');
        });
    });

    promiseIt('should match entire object graphs', function () {
        var originServerPort = port + 1,
            originServerFn = 'function (request, state) {\n' +
                             '    state.count = state.count || 0;\n' +
                             '    state.count += 1;\n' +
                             '    return {\n' +
                             '        body: state.count + ". " + JSON.stringify(request.query)\n' +
                             '    };\n' +
                             '}',
            originServerStub = { responses: [{ inject: originServerFn }] },
            originServerRequest = {
                protocol: 'http',
                port: originServerPort,
                stubs: [originServerStub],
                name: this.name + ' origin server'
            },
            proxyDefinition = {
                to: 'http://localhost:' + originServerPort,
                mode: 'proxyOnce',
                predicateGenerators: [{ matches: { query: true } }]
            },
            proxyStub = { responses: [{ proxy: proxyDefinition }] },
            proxyRequest = { protocol: 'http', port: port, stubs: [proxyStub], name: this.name + ' proxy' };

        return api.post('/imposters', originServerRequest).then(function () {
            return api.post('/imposters', proxyRequest);
        }).then(function (response) {
            assert.strictEqual(response.statusCode, 201, JSON.stringify(response.body));
            return client.get('/?first=1&second=2', port);
        }).then(function (response) {
            assert.strictEqual(response.body, '1. {"first":"1","second":"2"}');
            return client.get('/?first=1', port);
        }).then(function (response) {
            assert.strictEqual(response.body, '2. {"first":"1"}');
            return client.get('/?first=2&second=2', port);
        }).then(function (response) {
            assert.strictEqual(response.body, '3. {"first":"2","second":"2"}');
            return client.get('/?first=1&second=2', port);
        }).then(function (response) {
            assert.strictEqual(response.body, '1. {"first":"1","second":"2"}');
            return api.del('/imposters/' + originServerPort);
        }).finally(function () {
            return api.del('/imposters');
        });
    });

    promiseIt('should match sub-objects', function () {
        var originServerPort = port + 1,
            originServerFn = 'function (request, state) {\n' +
                             '    state.count = state.count || 0;\n' +
                             '    state.count += 1;\n' +
                             '    return {\n' +
                             '        body: state.count + ". " + JSON.stringify(request.query)\n' +
                             '    };\n' +
                             '}',
            originServerStub = { responses: [{ inject: originServerFn }] },
            originServerRequest = {
                protocol: 'http',
                port: originServerPort,
                stubs: [originServerStub],
                name: this.name + ' origin server'
            },
            proxyDefinition = {
                to: 'http://localhost:' + originServerPort,
                mode: 'proxyOnce',
                predicateGenerators: [{ matches: { query: { first: true } } }]
            },
            proxyStub = { responses: [{ proxy: proxyDefinition }] },
            proxyRequest = { protocol: 'http', port: port, stubs: [proxyStub], name: this.name + ' proxy' };

        return api.post('/imposters', originServerRequest).then(function () {
            return api.post('/imposters', proxyRequest);
        }).then(function (response) {
            assert.strictEqual(response.statusCode, 201, JSON.stringify(response.body));
            return client.get('/?first=1&second=2', port);
        }).then(function (response) {
            assert.strictEqual(response.body, '1. {"first":"1","second":"2"}');
            return client.get('/?second=2', port);
        }).then(function (response) {
            assert.strictEqual(response.body, '2. {"second":"2"}');
            return client.get('/?first=2&second=2', port);
        }).then(function (response) {
            assert.strictEqual(response.body, '3. {"first":"2","second":"2"}');
            return client.get('/?first=1&second=2&third=3', port);
        }).then(function (response) {
            assert.strictEqual(response.body, '1. {"first":"1","second":"2"}');
            return api.del('/imposters/' + originServerPort);
        }).finally(function () {
            return api.del('/imposters');
        });
    });
});
