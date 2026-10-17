from pathlib import Path
import subprocess, shutil, tempfile
root=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="homepulse-tests-") as folder:
    folder=Path(folder)
    for p in (root/"tests").glob("*.mjs"):shutil.copy2(p,folder/p.name)
    exports="\nexport {createAppApi,createGroundedService,Journal,openapi,requestStructuredObject,runtimeContext,requestRouter,requestedSamplingSeconds,validateSamplingRecommendation,ContractEngine,primitivePlan,validateContract,executionCapabilities,executionIssues,pairEvidenceIssue,missingTimeQuestion,boundedVision};\n"
    (folder/"server-test-only.mjs").write_text((root/"web/server-bundle.mjs").read_text()+exports)
    subprocess.run(["node","--test",str(folder/"automation.test.mjs"),str(folder/"server-regression.test.mjs")],check=True)
