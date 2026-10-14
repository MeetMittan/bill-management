/**
 * Audit & Tax Analytics - Chart.js Visualizations
 */

document.addEventListener('DOMContentLoaded', () => {
  renderDashboardCharts();
});

async function renderDashboardCharts() {
  const categoryCanvas = document.getElementById('categoryPieChart');
  const monthlyCanvas = document.getElementById('monthlyTrendChart');

  if (!categoryCanvas && !monthlyCanvas) return;

  try {
    const response = await fetch('/api/analytics/data');
    if (!response.ok) return;

    const { categoryBreakdown, monthlyTrend } = await response.json();

    // 1. Render Category Doughnut Chart
    if (categoryCanvas && categoryBreakdown) {
      const ctxCat = categoryCanvas.getContext('2d');
      const hasData = categoryBreakdown.amounts && categoryBreakdown.amounts.length > 0;

      if (!hasData) {
        ctxCat.font = '14px sans-serif';
        ctxCat.fillStyle = '#94a3b8';
        ctxCat.textAlign = 'center';
        ctxCat.fillText('No bills uploaded yet to display category breakdown.', categoryCanvas.width / 2, categoryCanvas.height / 2);
      } else {
        new Chart(ctxCat, {
          type: 'doughnut',
          data: {
            labels: categoryBreakdown.labels,
            datasets: [{
              data: categoryBreakdown.amounts,
              backgroundColor: categoryBreakdown.colors,
              borderWidth: 2,
              borderColor: '#ffffff',
              hoverOffset: 6
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                position: 'bottom',
                labels: {
                  boxWidth: 12,
                  font: { size: 11, family: 'Inter, sans-serif' },
                  color: '#475569'
                }
              },
              tooltip: {
                callbacks: {
                  label: function(context) {
                    const val = context.raw || 0;
                    return ` ${context.label}: $${val.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
                  }
                }
              }
            },
            cutout: '68%'
          }
        });
      }
    }

    // 2. Render Monthly Spending & Tax Trend Chart
    if (monthlyCanvas && monthlyTrend) {
      const ctxMonth = monthlyCanvas.getContext('2d');
      const hasMonthlyData = monthlyTrend.totals && monthlyTrend.totals.length > 0;

      if (!hasMonthlyData) {
        ctxMonth.font = '14px sans-serif';
        ctxMonth.fillStyle = '#94a3b8';
        ctxMonth.textAlign = 'center';
        ctxMonth.fillText('Upload invoices across multiple dates to view monthly financial trends.', monthlyCanvas.width / 2, monthlyCanvas.height / 2);
      } else {
        new Chart(ctxMonth, {
          type: 'bar',
          data: {
            labels: monthlyTrend.labels,
            datasets: [
              {
                label: 'Net Subtotal ($)',
                data: monthlyTrend.subtotals,
                backgroundColor: '#3b82f6',
                borderRadius: 4
              },
              {
                label: 'Tax Paid (GST/VAT) ($)',
                data: monthlyTrend.taxes,
                backgroundColor: '#10b981',
                borderRadius: 4
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: {
                grid: { display: false },
                ticks: { font: { size: 11 }, color: '#64748b' }
              },
              y: {
                beginAtZero: true,
                grid: { color: '#f1f5f9' },
                ticks: {
                  font: { size: 11 },
                  color: '#64748b',
                  callback: (val) => `$${val}`
                }
              }
            },
            plugins: {
              legend: {
                position: 'top',
                align: 'end',
                labels: {
                  boxWidth: 12,
                  font: { size: 12 },
                  color: '#475569'
                }
              },
              tooltip: {
                callbacks: {
                  label: (ctx) => ` ${ctx.dataset.label}: $${ctx.raw.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                }
              }
            }
          }
        });
      }
    }
  } catch (err) {
    console.error('Failed to load chart analytics:', err);
  }
}

