# References and evidence map

The code is an engineering synthesis of historical models, official software documentation, and later methodological work. No single paper defines every optional component in this bundle.

## Core cell-cycle models

### Dean and Jett, 1974 — DJ

Dean PN, Jett JH. Mathematical analysis of DNA distributions from flow microfluorometry. *Journal of Cell Biology*. 1974;60:523–527. DOI: https://doi.org/10.1083/jcb.60.2.523

Supports the Gaussian G1/G2 peaks, quadratic latent S-phase distribution, and convolutional broadening that became the Dean–Jett model.

### Fox, 1980 — DJF

Fox MH. A model for the computer analysis of synchronous DNA distributions obtained by flow cytometry. *Cytometry*. 1980;1(1):71–77. DOI: https://doi.org/10.1002/cyto.990010114

Supports the added floating Gaussian in the latent S-phase profile, constant-CV broadening, nonlinear fitting, and use with synchronized populations.

### Watson, Chambers, and Smith, 1987 — Watson Pragmatic

Watson JV, Chambers SH, Smith PJ. A pragmatic approach to the analysis of DNA histograms with a definable G1 peak. *Cytometry*. 1987;8(1):1–8. DOI: https://doi.org/10.1002/cyto.990080101

Supports the pragmatic local-Gaussian peak approach and residual estimation of S phase.

### Orlando et al., 2009 — CLOCCS

Orlando DA, Iversen ES Jr, Hartemink AJ, Haase SB. A branching process model for flow cytometry and budding index measurements in cell synchrony experiments. *Annals of Applied Statistics*. 2009;3(4):1521–1541. DOI: https://doi.org/10.1214/09-AOAS264

Supports the cohort/lifeline branching-process model, daughter delay, loss of synchrony, and joint use of DNA-content and budding-index time series.

## Signal processing and automatic initialization

### Lindeberg, 1998 — multi-scale feature detection

Lindeberg T. Feature detection with automatic scale selection. *International Journal of Computer Vision*. 1998;30(2):77–116. DOI: https://doi.org/10.1023/A:1008045108935

Supports the general principle that feature stability across Gaussian scale space is more robust than selecting one arbitrary smoothing scale. The package uses a simpler one-dimensional persistence heuristic, not Lindeberg's complete scale-normalized detector.

### SciPy signal peak documentation

- `scipy.signal.find_peaks`: https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.find_peaks.html
- `scipy.signal.peak_prominences`: https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.peak_prominences.html
- `scipy.signal.peak_widths`: https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.peak_widths.html

Documents conventional peak properties including height, distance, prominence, and width. The JavaScript implementation is dependency-free and not a line-for-line port.

## Optimization and model selection

### Marquardt, 1963

Marquardt DW. An algorithm for least-squares estimation of nonlinear parameters. *SIAM Journal on Applied Mathematics*. 1963;11(2):431–441. DOI: https://doi.org/10.1137/0111030

Fox used the Marquardt algorithm for nonlinear parameter fitting.

### Nelder and Mead, 1965

Nelder JA, Mead R. A simplex method for function minimization. *The Computer Journal*. 1965;7(4):308–313. DOI: https://doi.org/10.1093/comjnl/7.4.308

The package uses a bounded, projected Nelder–Mead implementation as transparent reference code, not as a claim of optimality.

### Akaike, 1974

Akaike H. A new look at the statistical model identification. *IEEE Transactions on Automatic Control*. 1974;19(6):716–723. DOI: https://doi.org/10.1109/TAC.1974.1100705

Supports AIC.

### Schwarz, 1978

Schwarz G. Estimating the dimension of a model. *Annals of Statistics*. 1978;6(2):461–464. DOI: https://doi.org/10.1214/aos/1176344136

Supports BIC.

## Preprocessing, contaminants, and orthogonal markers

### Wersto et al., 2001

Wersto RP, Chrest FJ, Leary JF, Morris C, Stetler-Stevenson MA, Gabrielson E. Doublet discrimination in DNA cell-cycle analysis. *Cytometry*. 2001;46(5):296–306.

Supports the importance of pulse-geometry/doublet discrimination in DNA cell-cycle analysis.

### Nicoletti et al., 1991

Nicoletti I, Migliorati G, Pagliacci MC, Grignani F, Riccardi C. A rapid and simple method for measuring thymocyte apoptosis by propidium iodide staining and flow cytometry. *Journal of Immunological Methods*. 1991;139(2):271–279. DOI: https://doi.org/10.1016/0022-1759(91)90198-O

Historical support for sub-G1 DNA fragmentation assays. The bundle deliberately uses the cautious label `sub-G1-like` because DNA content alone is not specific for apoptosis.

### Dolbeare et al., 1983

Dolbeare F, Gratzner H, Pallavicini MG, Gray JW. Flow cytometric measurement of total DNA content and incorporated bromodeoxyuridine. *Proceedings of the National Academy of Sciences USA*. 1983;80(18):5573–5577. DOI: https://doi.org/10.1073/pnas.80.18.5573

Supports bivariate DNA/BrdU measurement for identifying DNA-synthesizing cells.

### Salic and Mitchison, 2008

Salic A, Mitchison TJ. A chemical method for fast and sensitive detection of DNA synthesis in vivo. *Proceedings of the National Academy of Sciences USA*. 2008;105(7):2415–2420. DOI: https://doi.org/10.1073/pnas.0712168105

Supports EdU click-chemistry labeling of DNA synthesis.

## Official implementation guidance

### FlowJo: Cell Cycle—Univariate

https://docs.flowjo.com/flowjo/experiment-based-platforms/cell-cycle-univariate/

Documents FlowJo’s Watson Pragmatic and DJF choices, initialization behavior, optional synchronous S-phase component, and peak/CV constraints.

### FlowJo: Univariate Hints

https://docs.flowjo.com/flowjo/experiment-based-platforms/cell-cycle-univariate/plat-cc-hints/

Supports preprocessing doublets/dead cells/debris, using control-derived constraints, avoiding apoptosis inference from DNA alone, and using a second marker when individual S-phase identification matters.

### FlowJo: Univariate Statistics

https://docs.flowjo.com/flowjo/experiment-based-platforms/cell-cycle-univariate/plat-cc-statistics/

Distinguishes probabilistic model-derived percentages from post-fit range gates and describes fit summaries.

## Evidence boundaries

The following are modern implementation recommendations rather than a literal reproduction of one historical publication:

- multi-scale peak persistence, intrinsic-width impulse downweighting, weighted G1/G2 pair scoring, and heuristic confidence;
- Poisson count likelihood instead of Fox’s weighted least squares;
- bounded/transformed parameterization;
- AICc/BIC plus residual guardrails for component selection;
- parametric bootstrap uncertainty;
- self-convolution as an unresolved-doublet fallback;
- modular debris and multiple-ploidy mixtures;
- event-level posterior fusion of DNA and marker likelihoods.

These choices should be validated for the target assay and documented as the software’s own methodology.
