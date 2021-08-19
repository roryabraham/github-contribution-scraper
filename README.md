# github-contribution-scraper
This is a command-line tool to gather GitHub contributions for a given date or date range. It gathers the following data:

- PRs and issues you created
- Commits that you created, and their related PRs
- Comments that you left on issues and pull requests

To use it:

1. First, get a [GitHub Personal Access Token (PAT)](https://docs.github.com/en/github/authenticating-to-github/keeping-your-account-and-data-secure/creating-a-personal-access-token)
2. Next, clone this repo and run `npm i`
3. Then, from the project root, run `node ./getGitHubContributions.js --token=<YOUR_GH_PAT> --date=2020-06-01`
4. Run `node ./getGitHubContributions.js --help` for more information and run configs.

```
Options:
--help        Show help                                          [boolean]
--version     Show version number                                [boolean]
-t, --token       GitHub Personal Access Token (PAT)       [string] [required]
-d, --date        Specific date to find data for                      [string]
--startDate   Beginning of date range to find data for            [string]
--endDate     End of date range to find data for                  [string]
-o, --outputFile  Filepath for output file   [string] [default: "output.html"]
```
