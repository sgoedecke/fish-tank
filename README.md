# AI Fish Tank

Uses [GitHub Models](https://github.com/marketplace/models) to compare the performance of many small models in a simulated physics competition (collect the yellow dots):

![image](https://github.com/user-attachments/assets/0e743bfa-527b-48f9-9d4f-a4d61974c2b5)

## Setup

Set your `GITHUB_TOKEN` env var to a GitHub PAT (doesn't need any permissions). If you have `gh` installed you can use the one from `gh auth token`.

Then `npm install` and `npm run start` to start the local server.

You can plug in any model from the [list](https://github.com/marketplace/models). The more you run at the same time, the slower the rate-of-decision will get to stay under the rate limit.

## Motivation

AI models are often evaluated against benchmarks or with direct human voting (e.g. [LLMSYS/Chatbot Arena](https://lmarena.ai/)). Benchmarks have many known issues (leaking into training data, evaluating mostly-right answers, etc), and human voting biases towards longer and more impressive-sounding answers. A lot of the most informed people judge models based on vibe, or "big model smell". There's been some recent work at putting models in a simulated space (e.g. a Minecraft build-off [here](https://x.com/hamptonism/status/1849537031568781424)) to get a sense of their creativity and ability to construct a large or complex project, but that's really early so far.

I thought it'd be interesting to evaluate models based on their competition with each other in a simulated space: purely adversarial. 

Disclaimer: I work on GitHub Models at GitHub, but this isn't a formal GitHub project or affiliated in any way. I built this on the weekend because I thought it was a neat idea.