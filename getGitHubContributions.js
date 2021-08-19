#!/usr/bin/env node

const _ = require('underscore');
const {exit} = require('process');
const {writeFileSync} = require('fs');
const moment = require('moment-timezone');
const {Octokit} = require('@octokit/rest');
const {throttling} = require('@octokit/plugin-throttling');
const yargs = require('yargs');
const DateUtils = require('./dateUtils');

const argv = yargs
    .options({
        'token': {type: 'string', alias: 't', demandOption: true, describe: 'GitHub Personal Access Token (PAT)'},
        'date': {type: 'string', alias: 'd', describe: 'Specific date to find data for', conflicts: ['startDate', 'endDate']},
        'startDate': {type: 'string', describe: 'Beginning of date range to find data for', implies: 'endDate', conflicts: 'date'},
        'endDate': {type: 'string', describe: 'End of date range to find data for', implies: 'startDate', conflicts: 'date'},
        'outputFile': {type: 'string', alias: 'o', describe: 'Filepath for output file', default: 'output.html'},
    })
    .check((argv) => {
        _.each(_.pick(argv, ['date', 'startDate', 'endDate']), (date, option) => {
            if (!moment(date).isValid()) {
                throw new Error(`Error: ${option} ${date} is not a valid date`);
            }
        });

        if (!_.isEmpty(argv.startDate) && !_.isEmpty(argv.endDate) && moment(argv.startDate).isAfter(argv.endDate)) {
            throw new Error(`Error: startDate ${argv.startDate} is after endDate ${argv.endDate}`);
        }

        return true;
    }).argv;

// Adjust date for timezone for GitHub
const GITHUB_TIMEZONE_FORMAT = 'YYYY-MM-DDTHH:mm:ssZ';
const startDate = moment.tz(`${argv.startDate ?? argv.date} 00:00:00`, 'America/Los_Angeles')
    .format(GITHUB_TIMEZONE_FORMAT);
const endDate = moment.tz(`${argv.endDate ?? argv.date} 23:59:59`, 'America/Los_Angeles')
    .format(GITHUB_TIMEZONE_FORMAT);

// Setup Octokit
const OctokitThrottled = Octokit.plugin(throttling);
const octokit = new OctokitThrottled({
    auth: argv.token,
    throttle: {
        onRateLimit: (retryAfter, options) => {
            // Retry once after hitting a rate limit error, then give up
            if (options.request.retryCount <= 1) {
                return true;
            }
        },
        onAbuseLimit: (retryAfter, options) => {
            // does not retry, only logs a warning
            console.error(`Abuse detected for request ${options.method} ${options.url}`);
        },
    },
});

let username = '';
function getGitHubData() {
    return octokit.users.getAuthenticated()
        .then(({data}) => username = data.login)
        .then(() => Promise.all([
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
        ]))
        .then(([
            issuesAndPullRequestsCreated,
            reviewedPRs,
            issuesAndPullRequestsCommented,
            commits,
        ]) => {
            return Promise.all(_.map(
                issuesAndPullRequestsCommented,
                issue => octokit.paginate(`GET ${issue.comments_url.slice('https://api.github.com'.length)}`))
            )
                .then(comments => _.filter(_.flatten(comments), comment => comment.user.login === username))
                .then(comments => ({
                    issues: issuesAndPullRequestsCreated,
                    reviewedPRs: _.filter(reviewedPRs, reviewedPR => reviewedPR.user.login !== username),
                    comments,
                    commits,
                }));
        })
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
                .map(date => moment(date).format('YYYY-MM-DD'))
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
                    if (moment(issue.created_at).tz('America/Los_Angeles').isSame(distinctDate, 'day')) {
                        dataForDate.issues.push(issue);
                    }
                });
            });

            _.each(reviews, (review) => {
                _.each(fullDataSet, (dataForDate, distinctDate) => {
                    if (moment(review.submitted_at).tz('America/Los_Angeles').isSame(distinctDate, 'day')) {
                        dataForDate.reviews.push(review);
                    }
                });
            });

            _.each(comments, (comment) => {
                _.each(fullDataSet, (dataForDate, distinctDate) => {
                    if (moment(comment.created_at).tz('America/Los_Angeles').isSame(distinctDate, 'day')) {
                        dataForDate.comments.push(comment);
                    }
                });
            });

            _.each(commits, (commit) => {
                _.each(fullDataSet, (dataForDate, distinctDate) => {
                    if (moment(commit.commit.author.date).tz('America/Los_Angeles').isSame(distinctDate, 'day')) {
                        dataForDate.commits.push(commit);
                    }
                });
            });

            return fullDataSet;
        })
        .catch((e) => {
            console.error('Error: Unexpected GitHub API error –', e);
            exit(1);
        });
}

getGitHubData()
    .then((dataset) => {
        let output = '';
        _.each(dataset, ({issues, reviews, comments, commits}, date) => {
            if (!_.every([issues, reviews, comments, commits], item => _.isEmpty(item))) {
                const outputDate = moment(date).format('MMM Do YYYY').toUpperCase();
                output += `<h3>${outputDate} <a href='https://github.com/${username}?tab=overview&from=${date}&to=${date}'><span style='background-color: #6e549480;'>[Note: GH Activity]</span></a></h3>`;
                output += '<ul>';

                if (!_.isEmpty(issues)) {
                    _.each(issues, issue => output += `<li><span style='background-color: #6e549480;'>GH:</span> Created <a href='${issue.html_url}'>${issue.pull_request ? 'PR' : 'Issue'} #${issue.number}</a> &mdash; ${issue.title}</li>`);
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
                        output += `<li><span style='background-color: #6e549480;'>GH:</span> Updated PR #${prNumber} with the following commits:<ul>${_.map(_.pluck(prWithCommits.commits, 'html_url'), url => `<li><a href='${url}'>${url.split('/').pop().substring(0, 7)}</a></li>`).join('')}</ul></li>`;
                    });
                }

                if (!_.isEmpty(reviews)) {
                    _.each(reviews, review => output += `<li><span style='background-color: #6e549480;'>GH:</span> Reviewed <a href='${review.html_url}'>PR #${review.pull_request_url.split('/').pop()}</a> &mdash; ${review.prTitle}</li>`);
                }

                if (!_.isEmpty(comments)) {
                    output += `<li><span style='background-color: #6e549480;'>GH:</span> Comments:<ul>${_.map(_.pluck(comments, 'html_url'), url => `<li><a href='${url}'>${url.slice('https://github.com/Expensify/'.length)}</a></li>`).join('')}</ul></li>`;
                }

                output += '</ul>';
            }
        });
        writeFileSync(argv.outputFile, output);
    });
