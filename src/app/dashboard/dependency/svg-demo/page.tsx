'use client';

import { useState } from 'react';
import DependencyGraphSVG, { Pod } from '@/components/dashboard/dependency-graph-svg';

const DependencyGraphSVGDemo = () => {
  // Example pod data with root cause scenario
  const [pods] = useState<Pod[]>([
    // Root cause pod (center)
    {
      name: 'payment-service',
      status: 'FAILED',
      isRootCause: true,
      nodeType: 'compute',
      dependsOn: ['postgres-db', 'redis-cache'],
      impactedBy: ['order-api', 'checkout-service'],
    },
    // Source pods (left - depend on root cause)
    {
      name: 'postgres-db',
      status: 'RUNNING',
      isRootCause: false,
      nodeType: 'storage',
      dependsOn: [],
      impactedBy: ['payment-service'],
    },
    {
      name: 'redis-cache',
      status: 'RUNNING',
      isRootCause: false,
      nodeType: 'storage',
      dependsOn: [],
      impactedBy: ['payment-service'],
    },
    // Downstream pods (right - impacted by root cause)
    {
      name: 'order-api',
      status: 'FAILED',
      isRootCause: false,
      nodeType: 'web',
      dependsOn: ['payment-service'],
      impactedBy: [],
    },
    {
      name: 'checkout-service',
      status: 'PENDING',
      isRootCause: false,
      nodeType: 'web',
      dependsOn: ['payment-service'],
      impactedBy: [],
    },
    {
      name: 'notification-service',
      status: 'RUNNING',
      isRootCause: false,
      nodeType: 'compute',
      dependsOn: ['payment-service'],
      impactedBy: [],
    },
    {
      name: 'analytics-engine',
      status: 'HEALTHY',
      isRootCause: false,
      nodeType: 'system',
      dependsOn: ['payment-service'],
      impactedBy: [],
    },
    {
      name: 'monitoring-agent',
      status: 'RUNNING',
      isRootCause: false,
      nodeType: 'system',
      dependsOn: ['payment-service'],
      impactedBy: [],
    },
  ]);

  const [selectedPod, setSelectedPod] = useState<string | null>(null);

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 to-gray-800 p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">
            Kubernetes Dependency Graph
          </h1>
          <p className="text-gray-300">
            Interactive SVG visualization with 3-column layout and status indicators
          </p>
        </div>

        {/* Graph Container */}
        <div className="bg-white rounded-xl shadow-2xl overflow-hidden mb-8">
          <DependencyGraphSVG
            pods={pods}
            onNodeClick={setSelectedPod}
            width={1200}
            height={700}
          />
        </div>

        {/* Information Panel */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Pod Details */}
          <div className="bg-white rounded-lg shadow-lg p-6">
            <h2 className="text-xl font-bold text-gray-900 mb-4">Pod Details</h2>
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {pods.map(pod => (
                <div
                  key={pod.name}
                  onClick={() => setSelectedPod(pod.name)}
                  className={`p-4 rounded-lg cursor-pointer transition-all ${
                    selectedPod === pod.name
                      ? 'bg-blue-100 border-2 border-blue-500'
                      : 'bg-gray-50 border border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="font-semibold text-gray-900">{pod.name}</div>
                  <div className="flex items-center gap-3 mt-2 text-sm">
                    <span
                      className={`px-3 py-1 rounded-full text-white font-semibold ${
                        pod.status === 'FAILED'
                          ? 'bg-red-500'
                          : pod.status === 'PENDING'
                            ? 'bg-yellow-500'
                            : pod.status === 'RUNNING'
                              ? 'bg-blue-500'
                              : 'bg-green-500'
                      }`}
                    >
                      {pod.status}
                    </span>
                    {pod.isRootCause && (
                      <span className="px-3 py-1 rounded-full bg-red-100 text-red-700 font-semibold">
                        ROOT CAUSE
                      </span>
                    )}
                    <span className="text-gray-600">{pod.nodeType}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Legend & Instructions */}
          <div className="bg-white rounded-lg shadow-lg p-6">
            <h2 className="text-xl font-bold text-gray-900 mb-4">
              Legend & Layout
            </h2>

            <div className="space-y-6">
              <div>
                <h3 className="font-semibold text-gray-900 mb-3">
                  Status Colors
                </h3>
                <div className="space-y-2">
                  {[
                    { color: 'bg-red-500', label: 'Root Cause / Impacted' },
                    { color: 'bg-blue-500', label: 'Running' },
                    { color: 'bg-yellow-500', label: 'Pending' },
                    { color: 'bg-teal-500', label: 'Healthy Service' },
                    { color: 'bg-gray-400', label: 'System Pod' },
                  ].map(item => (
                    <div
                      key={item.label}
                      className="flex items-center gap-3 text-sm"
                    >
                      <div
                        className={`w-6 h-6 rounded ${item.color}`}
                      ></div>
                      <span className="text-gray-700">{item.label}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h3 className="font-semibold text-gray-900 mb-3">Layout</h3>
                <ul className="space-y-2 text-sm text-gray-700 list-disc list-inside">
                  <li>
                    <strong>Left Column:</strong> Source pods (dependencies)
                  </li>
                  <li>
                    <strong>Center:</strong> Root cause pod
                  </li>
                  <li>
                    <strong>Right Column:</strong> Downstream pods (75px
                    spacing)
                  </li>
                </ul>
              </div>

              <div>
                <h3 className="font-semibold text-gray-900 mb-3">
                  Interactions
                </h3>
                <ul className="space-y-2 text-sm text-gray-700 list-disc list-inside">
                  <li>
                    <strong>Click any node</strong> to select and highlight
                  </li>
                  <li>
                    <strong>Dashed arrows</strong> show dependencies
                  </li>
                  <li>
                    <strong>Status tags</strong> indicate pod state
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        {/* Features List */}
        <div className="mt-8 bg-white rounded-lg shadow-lg p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-4">Features</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              'Clean 3-column layout',
              'Deterministic node positioning',
              'No overlapping nodes',
              'Clickable nodes',
              'Clear status indicators',
              'Dashed arrow connections',
              'Color-coded by status',
              'Responsive design',
              'Color legend included',
            ].map(feature => (
              <div
                key={feature}
                className="flex items-center gap-3 p-3 bg-blue-50 rounded"
              >
                <svg
                  className="w-5 h-5 text-blue-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                <span className="text-gray-700">{feature}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default DependencyGraphSVGDemo;
