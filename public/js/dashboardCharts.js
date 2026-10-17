/**
 * Financial Analytics - Chart.js Visualizations (Indian Rupees ₹)
 */

document.addEventListener('DOMContentLoaded', () => {
  renderDashboardCharts();
});

let categoryChartInstance = null;
let monthlyChartInstance = null;

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
      if (categoryChartInstance) {
        categoryChartInstance.destroy();
      }
      const ctxCat = categoryCanvas.getContext('2d');
      const hasData = categoryBreakdown.amounts && categoryBreakdown.amounts.length > 0;

      if (!hasData) {
        ctxCat.font = '13px sans-serif';
        ctxCat.fillStyle = '#64748b';
        ctxCat.textAlign = 'center';
        ctxCat.fillText('No invoices found to display category breakdown.', categoryCanvas.width / 2, categoryCanvas.height / 2);
      } else {
        // Refined calm color palette
        const palette = ['#0f172a', '#3b82f6', '#475569', '#64748b', '#0d9488', '#e2e8f0'];
        const colors = categoryBreakdown.labels.map((_, i) => palette[i % palette.length]);

        categoryChartInstance = new Chart(ctxCat, {
          type: 'doughnut',
          data: {
            labels: categoryBreakdown.labels,
            datasets: [{
              data: categoryBreakdown.amounts,
              backgroundColor: colors,
              borderWidth: 2,
              borderColor: '#ffffff',
              hoverOffset: 4
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                position: 'bottom',
                labels: {
                  boxWidth: 10,
                  boxHeight: 10,
                  font: { size: 12, family: 'Inter, sans-serif' },
                  color: '#334155',
                  padding: 12
                }
              },
              tooltip: {
                callbacks: {
                  label: function(context) {
                    const val = context.raw || 0;
                    return ` ${context.label}: ₹${val.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
                  }
                }
              }
            },
            cutout: '72%'
          }
        });
      }
    }

    // 2. Render Monthly Spending & Tax Trend Chart
    if (monthlyCanvas && monthlyTrend) {
      if (monthlyChartInstance) {
        monthlyChartInstance.destroy();
      }
      const ctxMonth = monthlyCanvas.getContext('2d');
      const hasMonthlyData = monthlyTrend.totals && monthlyTrend.totals.length > 0;

      if (!hasMonthlyData) {
        ctxMonth.font = '13px sans-serif';
        ctxMonth.fillStyle = '#64748b';
        ctxMonth.textAlign = 'center';
        ctxMonth.fillText('Upload invoices across dates to view monthly trends.', monthlyCanvas.width / 2, monthlyCanvas.height / 2);
      } else {
        monthlyChartInstance = new Chart(ctxMonth, {
          type: 'bar',
          data: {
            labels: monthlyTrend.labels,
            datasets: [
              {
                label: 'Subtotal (₹)',
                data: monthlyTrend.subtotals,
                backgroundColor: '#0f172a',
                borderRadius: 4
              },
              {
                label: 'Tax (₹)',
                data: monthlyTrend.taxes,
                backgroundColor: '#3b82f6',
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
                  callback: (val) => `₹${val}`
                }
              }
            },
            plugins: {
              legend: {
                position: 'top',
                align: 'end',
                labels: {
                  boxWidth: 10,
                  boxHeight: 10,
                  font: { size: 12 },
                  color: '#334155'
                }
              },
              tooltip: {
                callbacks: {
                  label: (ctx) => ` ${ctx.dataset.label}: ₹${ctx.raw.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
                }
              }
            }
          }
        });
      }
    }
  } catch (err) {
    console.error('Failed to load chart analytics:', err.message);
  }
}
