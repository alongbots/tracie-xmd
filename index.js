/** @format */
const express = require('express');
const app = express();
const { startTracie } = require('./lib/client');
const NodeCache = require('node-cache');
const PORT = process.env.PORT || 8000;
global.cache = {
	groups: new NodeCache({ stdTTL: 300, checkperiod: 320, useClones: false }),
	users: new NodeCache({ stdTTL: 600, checkperiod: 620, useClones: false }),
	messages: new NodeCache({ stdTTL: 60, checkperiod: 80, useClones: false }),
};
app.get('/', (req, res) => {
	res.send('Tracie Bot Server is running');
});

app.get('/status', (req, res) => {
	const status = {
		uptime: process.uptime(),
		timestamp: Date.now(),
		connected: global.sock ? true : false,
		cacheStats: {
			groups: {
				keys: global.cache.groups.keys().length,
				hits: global.cache.groups.getStats().hits,
				misses: global.cache.groups.getStats().misses,
			},
			users: {
				keys: global.cache.users.keys().length,
				hits: global.cache.users.getStats().hits,
				misses: global.cache.users.getStats().misses,
			},
			messages: {
				keys: global.cache.messages.keys().length,
				hits: global.cache.messages.getStats().hits,
				misses: global.cache.messages.getStats().misses,
			},
		},
	};

	res.json(status);
});

app.listen(PORT, () => {
	console.log(`Server running on port ${PORT}`);
	startTracie()
		.then(() => {
			console.log('Tracie bot connected successfully');
		})
		.catch(err => {
			console.error('Failed to initialize Tracie bot:', err);
		});
});
process.on('SIGINT', () => {
	console.log('Shutting down...');
	process.exit(0);
});
