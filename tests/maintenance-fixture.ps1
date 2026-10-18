# In-memory IIS boundary only. Production CLI bodies, journals and ownership logic run unchanged.
$script:maintenanceFixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('netarium-maintenance-fixture-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $script:maintenanceFixtureRoot | Out-Null
$script:maintenanceConfigurationXml = '<configuration />'
$script:maintenanceEvents = @()
function Get-NetariumMaintenancePaths {
    param([string]$InstallRoot)
    return [pscustomobject]@{ Directory = $script:maintenanceFixtureRoot; Lock = (Join-Path $script:maintenanceFixtureRoot 'owner.lock'); Journal = (Join-Path $script:maintenanceFixtureRoot 'journal.json') }
}
function Get-NetariumMaintenanceConfiguration {
    $xml = New-Object Xml.XmlDocument
    $xml.PreserveWhitespace = $false
    $xml.LoadXml($script:maintenanceConfigurationXml)
    return [pscustomobject]@{ Xml = $xml; SiteName = $null; Records = @() }
}
function Write-NetariumMaintenanceConfiguration {
    param($Configuration)
    $script:maintenanceEvents += 'commit'
    $script:maintenanceConfigurationXml = $Configuration.Xml.OuterXml
}
function Get-WebApplication { param($Site, $ErrorAction) return @() }
function Invoke-NetariumProbe {
    param([string]$Url, [switch]$IncludeBody)
    $script:maintenanceEvents += 'probe'
    $xml = New-Object Xml.XmlDocument; $xml.LoadXml($script:maintenanceConfigurationXml)
    $errorNode = $xml.SelectSingleNode('/configuration/location/system.webServer/httpErrors/error[@statusCode="404" and @subStatusCode="7"]')
    return [pscustomobject]@{ StatusCode = 404; Location = ''; Headers = @{ 'Content-Type' = 'application/json'; 'Cache-Control' = 'no-store' }; Body = [IO.File]::ReadAllText($errorNode.GetAttribute('path')) }
}
function Invoke-MaintenanceTestCli {
    param([string]$Path, [hashtable]$Arguments)
    # Omit only dependency loading: tests already load the real common functions, then mock OS boundaries.
    $text = [IO.File]::ReadAllText($Path)
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
    $loader = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.InvocationOperator -eq [Management.Automation.Language.TokenKind]::Dot }, $true))
    if ($errors.Count -or $loader.Count -ne 1) { throw 'Unexpected production CLI syntax/dependency loader.' }
    $text = $text.Remove($loader[0].Extent.StartOffset, $loader[0].Extent.EndOffset - $loader[0].Extent.StartOffset)
    & ([scriptblock]::Create($text)) @Arguments
}
