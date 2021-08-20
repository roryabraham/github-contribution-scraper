/**
 * This is a hacky substitute for Promise.all that does one async function call, then the next, in sequence.
 * This is an easy way to throttle API requests to alleviate rate-limiting issues.
 * Just like Promise.all, it returns a Promise containing an array with the results to each function call.
 *
 * @param {Array<Promise>} promises
 * @param {Number} additionalThrottling
 * @returns {Promise<Array<*>>}
 */
async function throttledPromiseAll (promises, additionalThrottling = 0) {
    let results = [];
    for (let promise of promises) {
        results.push(await promise);
        await new Promise(resolve => setTimeout(resolve, additionalThrottling));
    }
    return Promise.resolve(results);
}

module.exports = throttledPromiseAll;
