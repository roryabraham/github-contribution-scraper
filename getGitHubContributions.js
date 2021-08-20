#!/usr/bin/env node

const _ = require('underscore');
const lodashMerge = require('lodash/merge');
const {exit} = require('process');
const {existsSync, readFileSync, writeFileSync} = require('fs');
const moment = require('moment-timezone');
const {Octokit} = require('@octokit/rest');
const {throttling} = require('@octokit/plugin-throttling');
const yargs = require('yargs');
const CONST = require('./CONST');
const DateUtils = require('./dateUtils');
const throttledPromiseAll = require('./throttledPromiseAll');

const argv = yargs
    .options({
        'token': {type: 'string', alias: 't', demandOption: true, describe: 'GitHub Personal Access Token (PAT)'},
        'date': {type: 'string', alias: 'd', describe: 'Specific date to find data for', conflicts: ['startDate', 'endDate', 'tenAM']},
        'startDate': {type: 'string', describe: 'Beginning of date range to find data for', implies: 'endDate', conflicts: ['date', 'tenAM']},
        'endDate': {type: 'string', describe: 'End of date range to find data for', implies: 'startDate', conflicts: ['date', 'tenAM']},
        'outputFile': {type: 'string', alias: 'o', describe: 'Filepath for output file', default: 'output.html'},
        'tenAM': {type: 'string', describe: 'The location of a 10am dump file read', conflicts: ['date', 'startDate', 'endDate']},
        'timezone': {type: 'string', describe: 'The timezone you worked from on the provided dates.', default: CONST.DEFAULT_TIMEZONE},
    })
    .check((argv) => {
        _.each(_.pick(argv, ['date', 'startDate', 'endDate']), (date, option) => {
            if (!moment(date).isValid()) {
                throw new Error(`Error: ${option} ${date} is not a valid date`);
            }
        });

        if (argv.tenAM && !existsSync(argv.tenAM)) {
            throw new Error(`Error: Could not find file ${argv.tenAM}`);
        }

        if (!_.isEmpty(argv.startDate) && !_.isEmpty(argv.endDate) && moment(argv.startDate).isAfter(argv.endDate)) {
            throw new Error(`Error: startDate ${argv.startDate} is after endDate ${argv.endDate}`);
        }

        if (!DateUtils.isValidTimezone(argv.timezone)) {
            throw new Error(`Error: Timezone ${argv.timezone} is not valid`);
        }

        return true;
    }).argv;

// Setup Octokit
let searchThrottle = 500;
const OctokitThrottled = Octokit.plugin(throttling);
const octokit = new OctokitThrottled({
    auth: argv.token,
    throttle: {
        onRateLimit: (retryAfter, options) => {
            // Retry once after hitting a rate limit error, then give up
            if (options.request.retryCount <= 5) {
                console.warn(`Warning: Got rate-limited by the GH API for the ${options.request.retryCount} time.`);
                searchThrottle = 500 + (options.request.retryCount * 1000);
                return true;
            }
        },
        onAbuseLimit: (retryAfter, options) => {
            // does not retry, only logs a warning
            if (options.request.retryCount < 1) {
                console.warn('WARNING: Hit the abuse limit for the GH API, retrying once');
                searchThrottle *= 2;
                return true;
            }
            console.error(`Abuse detected for request ${options.method} ${options.url}`);
        },
    },
});

/**
 * Get the authenticated user's GitHub username.
 *
 * @returns {Promise<String>}
 */
async function getGitHubUsername() {
    return await octokit.users.getAuthenticated().then(({data}) => data.login);
}

/**
 * Get GitHub data for the given user + date range.
 *
 * @param {String} username
 * @param {String} startDate
 * @param {String} endDate
 * @param {String} twoWeeksBefore
 * @returns {Promise<Object>}
 */
function getGitHubData(username, startDate, endDate, twoWeeksBefore) {
    const dateRangePrintable = `${moment(startDate).format(CONST.DATE_FORMAT_STANDARD)}${moment(startDate).isSame(endDate, 'day') ? '' : ` to ${moment(endDate).format(CONST.DATE_FORMAT_STANDARD)}`}`;
    console.log(`Collecting GitHub data from ${dateRangePrintable}`);

    // Search for issues, pull requests, and commits
    // Do these one-after-another to alleviate rate-limiting issues
    return throttledPromiseAll([
        octokit.paginate(octokit.search.issuesAndPullRequests, {
            q: `org:Expensify author:${username} created:${startDate}..${endDate}`,
        }),
        octokit.paginate(octokit.search.issuesAndPullRequests, {
            q: `org:Expensify is:pr reviewed-by:${username} created:${startDate}..${endDate}`,
            per_page: 100,
        }),
        octokit.paginate(octokit.search.issuesAndPullRequests, {
            q: `org:Expensify commenter:${username} updated:${startDate}..${endDate}`,
        }),
        octokit.paginate(octokit.search.commits, {
            q: `org:Expensify author:${username} author-date:${startDate}..${endDate}`,
        }),
    ], searchThrottle)

        // Fetch comments for the issues the user commented on,
        // and filter out reviewed PRs created by the user
        .then(([
            issuesAndPullRequestsCreated,
            reviewedPRs,
            issuesAndPullRequestsCommented,
            commits,
        ]) => Promise.all(_.map(
            issuesAndPullRequestsCommented,
            issue => octokit.paginate(`GET ${issue.comments_url.slice('https://api.github.com'.length)}`)
        ))
            .then(comments => _.filter(_.flatten(comments), comment => comment.user.login === username))
            .then(comments => ({
                issues: issuesAndPullRequestsCreated,
                reviewedPRs: _.filter(reviewedPRs, reviewedPR => reviewedPR.user.login !== username),
                comments,
                commits,
            }))
        )

        // Use the beta Timeline API to fetch review events for the given user on the reviewed PRs
        .then(({
            issues,
            reviewedPRs,
            comments,
            commits,
        }) => Promise.all(_.map(
            reviewedPRs,
            reviewedPR => octokit.paginate(
                `GET ${reviewedPR.url.slice('https://api.github.com'.length)}/timeline`,
                {headers: {Accept: 'application/vnd.github.mockingbird-preview'}}
            )))
            .then(events => _.flatten(events, 1))
            .then(events => _.filter(events, event => event.event === 'reviewed' && event.user.login === username))
            .then(reviews => _.map(reviews, review => {
                let url = review.html_url.replace(/#.*$/, '');
                let pr = _.find(reviewedPRs, reviewedPR => reviewedPR.html_url === url);
                review.prTitle = pr.title;
                return review;
            }))
            .then(reviews => ({
                issues,
                reviews,
                comments,
                commits,
            }))
        )

        // Map commits to an array of PRs associated with that commit
        .then(({
            issues,
            reviews,
            comments,
            commits,
        }) => Promise.all(_.map(
            commits,
            commit => octokit.repos.listPullRequestsAssociatedWithCommit({
                owner: 'Expensify',
                repo: commit.repository.name,
                commit_sha: commit.sha,
            })
                .then(({data}) => ({
                    ...commit,
                    associatedPullRequests: _.filter(data, pr => pr.user.login === username),
                }))
        ))
            .then(commitsWithAssociatedPullRequests => ({
                issues,
                reviews,
                comments,
                commits: _.filter(commitsWithAssociatedPullRequests, commit => !_.isEmpty(commit.associatedPullRequests)),
            }))
        )

        /* Aggregate data by date, where the resultant data set will have the shape:
         * {
         *   '2021-06-01': {issues: [], reviews: [], comments: [], commits: []},
         *   '2021-06-02': ...
         * }
         */
        .then(({
            issues,
            reviews,
            comments,
            commits,
        }) => {
            const fullDataSet = _.chain([
                startDate,
                ...DateUtils.enumerateDaysBetweenDates(startDate, endDate),
                endDate,
            ])
                .flatten()
                .map(date => moment(date).format(CONST.DATE_FORMAT_STANDARD))
                .reduce((memo, date) => {
                    memo[date] = {
                        issues: [],
                        reviews: [],
                        comments: [],
                        commits: [],
                    };
                    return memo;
                }, {})
                .value();

            _.each(issues, (issue) => {
                _.each(fullDataSet, (dataForDate, distinctDate) => {
                    if (moment(issue.created_at).tz(argv.timezone).isSame(distinctDate, 'day')) {
                        dataForDate.issues.push(issue);
                    }
                });
            });

            _.each(reviews, (review) => {
                _.each(fullDataSet, (dataForDate, distinctDate) => {
                    if (moment(review.submitted_at).tz(argv.timezone).isSame(distinctDate, 'day')) {
                        dataForDate.reviews.push(review);
                    }
                });
            });

            _.each(comments, (comment) => {
                _.each(fullDataSet, (dataForDate, distinctDate) => {
                    if (moment(comment.created_at).tz(argv.timezone).isSame(distinctDate, 'day')) {
                        dataForDate.comments.push(comment);
                    }
                });
            });

            _.each(commits, (commit) => {
                _.each(fullDataSet, (dataForDate, distinctDate) => {
                    if (moment(commit.commit.author.date).tz(argv.timezone).isSame(distinctDate, 'day')) {
                        dataForDate.commits.push(commit);
                    }
                });
            });

            console.log(`Finished collecting GitHub data from ${dateRangePrintable}`);
            return fullDataSet;
        })
        .catch((e) => {
            console.error('Error: Unexpected GitHub API error –', e);
            exit(1);
        });
}

/**
 * Parse 10am data from file.
 *
 * @param {String} filepath
 * @returns {Object}
 */
function parseTenAMData(filepath) {
    console.log(`Reading data from 10am dump file: ${filepath}`);
    const rawTenAMData = readFileSync(filepath).toString();

    // Split data by year
    const annualData = _.reduce(
        rawTenAMData.split(new RegExp(`(${CONST.YEARS.join('|')})\n`)),
        (acc, datum) => {
            if (datum) {
                if (CONST.YEARS.includes(datum)) {
                    acc[datum] = '';
                } else {
                    for (let year of CONST.YEARS) {
                        if (_.has(acc, year)) {
                            acc[year] += datum;
                            break;
                        }
                    }
                }
            }
            return acc;
        },
        {},
    );

    // Split data by month
    const monthlyData = _.reduce(
        annualData,
        (acc, data, year) => {
            if (!_.has(acc, year)) {
                acc[year] = {};
            }
            _.each(
                data.split(new RegExp(`(${CONST.MONTHS.join('|')})\n`)),
                datum => {
                    if (datum) {
                        if (_.contains(CONST.MONTHS, datum)) {
                            acc[year][datum] = '';
                        } else {
                            for (let month of CONST.MONTHS) {
                                if (_.has(acc[year], month)) {
                                    acc[year][month] += datum;
                                    break;
                                }
                            }
                        }
                    }
                }
            );
            return acc;
        },
        {}
    );

    return _.mapObject(
        monthlyData,
        (monthData, year) => _.mapObject(
            monthData,
            tenAMData => _.chain(tenAMData.split(new RegExp(`(${CONST.MONTHS_3_DIGIT.join('|')}) (\\d+)(?:ST|ND|RD|TH) \\d+ (?:${CONST.WEEKDAYS.join('|')})`)))
                .compact()
                .chunk(3)
                .reduce(
                    (memo, chunk) => {
                        const [month3Digit, date, content] = chunk;
                        const dateStandard = moment(`${month3Digit} ${date} ${year}`, 'MMM DD YYYY').format(CONST.DATE_FORMAT_STANDARD);
                        return {
                            ...memo,
                            [dateStandard]: content.trim(),
                        };
                    },
                    {},
                )
                .value()
        )
    );
}

/**
 * @param {String} date
 * @param {String} rawData
 * @returns {String}
 */
function formatTenAMDataForOutput(date, rawData) {
    let formatted = '';
    formatted += `<h3>${DateUtils.formatDateForOutput(date)}</h3>`;
    const lineItems = _.chain(rawData.split('\n'))
        .map(item => item.trim())
        .map(item => item.startsWith('• ') ? item.slice(2) : item)
        .compact()
        .value();

    if (!_.isEmpty(lineItems)) {
        formatted += '<ul>';
        _.each(lineItems, item => formatted += `<li>${item}</li>`);
        formatted += '</ul>';
        return formatted;
    }

    // No line items, so return nothing.
    return '';
}

/**
 * @param {String} username
 * @param {String} date
 * @param {Array} issues
 * @param {Array} reviews
 * @param {Array} comments
 * @param {Array} commits
 * @returns {String}
 */
function formatGHDataForOutput(username, date, issues, reviews, comments, commits) {
    let formatted = '';
    if (!_.every([issues, reviews, comments, commits], item => _.isEmpty(item))) {
        const outputDate = moment(date).format('MMM Do YYYY').toUpperCase();
        formatted += `<h3>${outputDate} <a href='https://github.com/${username}?tab=overview&from=${date}&to=${date}'><span style='background-color: cyan;'>[Note: GH Activity]</span></a></h3>`;
        formatted += '<ul>';

        if (!_.isEmpty(issues)) {
            _.each(issues, issue => formatted += `<li><span style='background-color: cyan;'>GH:</span> Created <a href='${issue.html_url}'>${issue.pull_request ? 'PR' : 'Issue'} #${issue.number}</a> &mdash; ${issue.title}</li>`);
        }

        const updatedPRsWithCommits = _.chain(commits)
            .reduce(
                (memo, commit) => {
                    _.each(commit.associatedPullRequests, pr => {
                        if (!_.has(memo, pr.number)) {
                            memo[pr.number] = {
                                url: pr.html_url,
                                commits: [commit],
                            };
                        } else {
                            memo[pr.number].commits.push(commit);
                        }
                    });
                    return memo;
                },
                {},
            )
            .omit(_.pluck(issues, 'number'))
            .value();

                if (!_.isEmpty(updatedPRsWithCommits)) {
                    _.each(updatedPRsWithCommits, (prWithCommits, prNumber) => {
                        formatted += `<li><span style='background-color: cyan;'>GH:</span> Updated <a href='${prWithCommits.url}'>PR #${prNumber}</a> &mdash;
                            ${prWithCommits.commits[0].associatedPullRequests[0].title} &mdash;with the following ${prWithCommits.commits.length} commit(s):
                            <ul>${_.map(_.pluck(prWithCommits.commits, 'html_url'), url => `<li><a href='${url}'>${url.split('/').pop().substring(0, 7)}</a></li>`).join('')}</ul></li>`;
                    });
                }

                if (!_.isEmpty(reviews)) {
                    _.each(reviews, review => formatted += `<li><span style='background-color: cyan;'>GH:</span> Reviewed <a href='${review.html_url}'>PR #${review.pull_request_url.split('/').pop()}</a> &mdash; ${review.prTitle}</li>`);
                }

        if (!_.isEmpty(comments)) {
            formatted += `<li><span style='background-color: cyan;'>GH:</span> Comments:<ul>${_.map(_.pluck(comments, 'html_url'), url => `<li><a href='${url}'>${url.slice('https://github.com/Expensify/'.length)}</a></li>`).join('')}</ul></li>`;
        }

        formatted += '</ul>';
    }
    return formatted;
}

async function run() {
    let output = '';
    const username = await getGitHubUsername();
    if (argv.tenAM) {
        const tenAMData = parseTenAMData(argv.tenAM);
        console.log(`Finished parsing 10am data from ${argv.tenAM}`);

        let mergedData = tenAMData;
        const earliestYear = Number(_.first(_.keys(tenAMData).sort()));
        const latestYear = Number(_.last(_.keys(tenAMData).sort()));
        for (let currentYear = latestYear; currentYear >= earliestYear; currentYear--) {
            const monthsSorted = _.sortBy(_.keys(tenAMData[currentYear]), month => _.indexOf(CONST.MONTHS, month));
            const earliestMonth = _.first(monthsSorted);
            const latestMonth = _.last(monthsSorted);
            for (let currentMonth of CONST.MONTHS.slice(_.indexOf(CONST.MONTHS, earliestMonth), _.indexOf(CONST.MONTHS, latestMonth) + 1).reverse()) {
                // Given the current month's 10ams, determine the date ranges we need to fetch GH data for
                const monthTenAMs = tenAMData[currentYear][currentMonth];
                const dateRanges = _.chain(Array.from(
                    {length: moment(`${currentMonth} ${currentYear}`, 'MMMM YYYY').daysInMonth()},
                    (_, i) => i + 1)
                )
                    .map(date => moment(`${currentMonth} ${date} ${currentYear}`, 'MMMM D YYYY').format(CONST.DATE_FORMAT_STANDARD))
                    .filter(date => DateUtils.isWeekday(date))
                    .difference(_.keys(monthTenAMs))
                    .reduce((acc, date) => {
                        const prevSubArray = _.last(acc);
                        if (!prevSubArray || Number(_.last(prevSubArray).slice(-2)) !== Number(date.slice(-2)) - 1) {
                            acc.push([]);
                        }
                        _.last(acc).push(date);
                        return acc;
                    }, [])
                    .value();

                for (let dateRange of dateRanges) {
                    const {startDate, endDate, twoWeeksBefore} = DateUtils.adjustDateAndTimezoneForGitHub(
                        argv.timezone,
                        _.first(dateRange),
                        _.last(dateRange),
                    );
                    const gitHubDataForRange = await getGitHubData(username, startDate, endDate, twoWeeksBefore);
                    lodashMerge(mergedData[currentYear][currentMonth], gitHubDataForRange);
                }

                console.log(`Finished gathering all data for ${currentMonth}, ${currentYear}`);
            }
        }

        _.each(mergedData, (monthData, year) => {
            _.each(monthData, (dailyData, month) => {
                const sortedDailyData = _.reduce(
                    _.keys(mergedData[year][month]).sort(),
                    (sorted, date) => ({
                        ...sorted,
                        [date]: mergedData[year][month][date],
                    }),
                    {},
                );
                _.each(sortedDailyData, (value, date) => {
                    if (_.isString(value)) {
                        // This is raw 10am data
                        output += formatTenAMDataForOutput(date, value);
                    } else {
                        // This is GH data
                        output += formatGHDataForOutput(username, date, value.issues, value.reviews, value.comments, value.commits);
                    }
                });
            });
        });
    } else {
        const {startDate, endDate, twoWeeksBefore} = DateUtils.adjustDateAndTimezoneForGitHub(
            argv.timezone,
            argv.startDate ?? argv.date,
            argv.endDate ?? argv.date,
        );
        getGitHubData(username, startDate, endDate, twoWeeksBefore)
            .then(dataset => {
                _.each(dataset, ({issues, reviews, comments, commits}, date) => {
                    if (!_.every([issues, reviews, comments, commits], item => _.isEmpty(item))) {
                        output += formatGHDataForOutput(username, date, issues, reviews, comments, commits);
                    }
                });
            });
    }

    writeFileSync(argv.outputFile, output);
}

if (require.main === module) {
    run();
}
