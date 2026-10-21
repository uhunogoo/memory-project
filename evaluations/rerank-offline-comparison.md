# Offline comparison of the pasted rerank results

Query: **«Чому перечитування створює ілюзію знання?»**. The saved run used hybrid search with `limit=5` and reported no warnings. Source: [pasted CLI output](</tmp/codex-file-preview-ikCgcS/Pasted text(1).txt>), attached in the chat «Опис архітектури проекту».

This comparison reorders only the five returned results by their existing `rerankScore`. The saved output was already truncated by the old blended ranking; it does not contain the full candidate pool. No new model calls or relevance judgments were used, and these five rows cannot establish the full-pool pure-rerank top five.

| Section                                             | Old blended rank |  Old blended score | Raw rerank score | Pure-rerank rank among these five |
| --------------------------------------------------- | ---------------: | -----------------: | ---------------: | --------------------------------: |
| 3.1. Чому перечитування не завжди означає розуміння |                1 | 0.9601068349999999 |       0.84042734 |                                 1 |
| 5.3. Знання як система, яку можна перевіряти        |                2 |        0.400163865 |       0.10065546 |                                 5 |
| 3.1.1. Інтервальне повторення                       |                3 |       0.3499556325 |       0.39982253 |                                 3 |
| 5.1. Спостереження перед рішенням                   |                4 |         0.32415152 |        0.4353788 |                                 2 |
| 3.2.1. Особиста база знань                          |                5 |         0.24636634 |       0.31591585 |                                 4 |

The first result stays the same. Section **5.3 drops from rank 2 to rank 5**; section 5.1 rises from 4 to 2. This demonstrates the ordering effect in the saved subset, without measuring retrieval quality across the missing candidates.

The separate [historical relevance report](/tmp/memory-relevance-2026-10-21.md) contains 20 queries: 16 with a declared target section and four without an answer in the document. It evaluated lexical, vector, and hybrid search before reranking. Its labels are preserved in [rerank-queries.json](/mnt/data3/Projects/memory-project/evaluations/rerank-queries.json); they identify target sections, not per-chunk relevance grades. This additional rereading query is not part of that 20-query cohort.

Neither saved artifact contains reranker scores for the four no-answer queries. The historical report records that all four returned results in all three retrieval modes, but provides no numeric score distribution. Fresh scores over a shared candidate pool are required before assessing any cutoff.
