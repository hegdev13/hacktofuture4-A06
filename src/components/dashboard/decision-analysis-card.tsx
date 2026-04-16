import { useState } from "react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type RemediationOption = {
  id: string;
  name: string;
  description: string;
  steps: string[];
  cost: {
    downtime: string;
    downtime_seconds: number;
    resource_impact: string;
    risk_level: string;
    execution_time: string;
  };
  pros: string[];
  cons: string[];
  confidence: number;
};

type DecisionAnalysisProps = {
  options: RemediationOption[];
  selectedOption: string;
  selectionReason: string;
  rootCause: string;
  affectedCount: number;
};

export function DecisionAnalysisCard({
  options,
  selectedOption,
  selectionReason,
  rootCause,
  affectedCount,
}: DecisionAnalysisProps) {
  const [expanded, setExpanded] = useState(false);
  const selected = options.find((opt) => opt.id === selectedOption);

  const getRiskColor = (level: string) => {
    if (level.toLowerCase() === "low") return "text-ok";
    if (level.toLowerCase() === "medium") return "text-accent";
    if (level.toLowerCase() === "high") return "text-danger";
    return "text-[#4f5d68]";
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex-1">
            <div className="text-xl font-bold tracking-tight text-[#1f2b33]">
              Remediation Decision Analysis
            </div>
            <div className="text-xs text-muted">
              {affectedCount} affected resources • Root cause: <code className="text-[#4f5d68]">{rootCause}</code>
            </div>
          </div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="rounded-md border border-[#d9c7b8] bg-[#f5f0e8] px-3 py-2 text-xs font-semibold text-[#4f5d68] hover:bg-[#ece5da]"
          >
            {expanded ? "Hide Details" : "Show Details"}
          </button>
        </div>
      </CardHeader>
      <CardBody>
        <div className="space-y-4">
          {/* Selected Option Summary */}
          {selected && (
            <div className="rounded-lg border border-[#d9e3ba] bg-[#f5fce8] p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-[#3d4e2c]">✓ Selected: {selected.name}</div>
                  <div className="mt-1 text-sm text-[#2d3d1c]">{selected.description}</div>
                  <div className="mt-3 text-xs font-medium text-[#3d4e2c]">Reasoning:</div>
                  <p className="mt-1 text-xs text-[#3d4e2c]">{selectionReason}</p>
                </div>
                <div className="text-right">
                  <div className="text-xs text-muted">Confidence</div>
                  <div className="text-lg font-bold text-ok">{Math.round(selected.confidence * 100)}%</div>
                </div>
              </div>
            </div>
          )}

          {/* All Options Comparison */}
          {expanded && (
            <div className="space-y-3">
              <div className="text-sm font-semibold text-[#1f2b33]">All Options Considered</div>
              <div className="grid gap-3">
                {options.map((option) => (
                  <div
                    key={option.id}
                    className={cn(
                      "rounded-lg border p-3 transition-colors",
                      selectedOption === option.id
                        ? "border-[#b8d4a8] bg-[#f2fce8]"
                        : "border-[#e3d7cc] bg-[#faf7f3]"
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <div className="font-semibold text-[#1f2b33]">
                          {selectedOption === option.id && "✓ "}{option.name}
                        </div>
                        <div className="mt-1 text-xs text-[#4f5d68]">{option.description}</div>

                        <div className="mt-3 grid gap-3 md:grid-cols-2">
                          {/* Cost Metrics */}
                          <div>
                            <div className="text-xs font-semibold text-muted">Cost & Impact</div>
                            <ul className="mt-1 space-y-1 text-xs text-[#4f5d68]">
                              <li>
                                <strong>Downtime:</strong> {option.cost.downtime}
                              </li>
                              <li>
                                <strong>Resources:</strong> {option.cost.resource_impact}
                              </li>
                              <li>
                                <strong>Time:</strong> {option.cost.execution_time}
                              </li>
                              <li>
                                <strong>Risk:</strong>{" "}
                                <span className={getRiskColor(option.cost.risk_level)}>
                                  {option.cost.risk_level}
                                </span>
                              </li>
                            </ul>
                          </div>

                          {/* Pros & Cons */}
                          <div>
                            <div className="text-xs font-semibold text-muted">Pros & Cons</div>
                            <ul className="mt-1 space-y-1 text-xs text-[#4f5d68]">
                              {option.pros.slice(0, 2).map((pro, i) => (
                                <li key={`pro-${i}`} className="text-ok">
                                  ✓ {pro}
                                </li>
                              ))}
                              {option.cons.slice(0, 1).map((con, i) => (
                                <li key={`con-${i}`} className="text-danger">
                                  ✗ {con}
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs text-muted">Confidence</div>
                        <div className="text-base font-bold text-[#4f5d68]">{Math.round(option.confidence * 100)}%</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Steps Detail */}
              {selected && (
                <div className="mt-4 border-t border-[#e3d7cc] pt-4">
                  <div className="text-sm font-semibold text-[#1f2b33]">Execution Steps: {selected.name}</div>
                  <ol className="mt-2 space-y-2 text-xs text-[#4f5d68]">
                    {selected.steps.map((step, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="font-semibold text-muted">{i + 1}.</span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
