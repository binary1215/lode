// Internal P5 query only: no process control, enumeration, provider or P2 authority.
export const WINDOWS_EXACT_PROCESS_QUERY = `
$taskAssembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('HeadExactProcessQuery'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
$taskModule=$taskAssembly.DefineDynamicModule('HeadExactProcessQuery')
$taskType=$taskModule.DefineType('HeadExactProcessQuery',[Reflection.TypeAttributes]'Public,Sealed,Abstract')
function Add-TaskQueryMethod([string]$taskName,[Type]$taskReturn,[Type[]]$taskParameters,[string]$taskLibrary='kernel32.dll'){
  $taskMethod=$taskType.DefineMethod($taskName,[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',$taskReturn,$taskParameters)
  $taskConstructor=[Runtime.InteropServices.DllImportAttribute].GetConstructor([Type[]]@([string]))
  $taskAttribute=[Reflection.Emit.CustomAttributeBuilder]::new($taskConstructor,[object[]]@($taskLibrary),[Reflection.FieldInfo[]]@([Runtime.InteropServices.DllImportAttribute].GetField('SetLastError')),[object[]]@($true))
  $taskMethod.SetCustomAttribute($taskAttribute)
  $taskMethod.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  if($taskName -eq 'OpenProcess'){$script:taskOpenMethod=$taskMethod}
}
Add-TaskQueryMethod 'OpenProcess' ([IntPtr]) ([Type[]]@([UInt32],[bool],[UInt32]))
Add-TaskQueryMethod 'GetProcessTimes' ([bool]) ([Type[]]@([IntPtr],[UInt64].MakeByRefType(),[UInt64].MakeByRefType(),[UInt64].MakeByRefType(),[UInt64].MakeByRefType()))
Add-TaskQueryMethod 'WaitForSingleObject' ([UInt32]) ([Type[]]@([IntPtr],[UInt32]))
Add-TaskQueryMethod 'CloseHandle' ([bool]) ([Type[]]@([IntPtr]))
Add-TaskQueryMethod 'NtQueryInformationProcess' ([Int32]) ([Type[]]@([IntPtr],[Int32],[IntPtr],[Int32],[Int32].MakeByRefType())) 'ntdll.dll'
$taskOpenExact=$taskType.DefineMethod('OpenExact',[Reflection.MethodAttributes]'Public,Static',[IntPtr],[Type[]]@([UInt32],[Int32].MakeByRefType()))
$taskIL=$taskOpenExact.GetILGenerator()
[void]$taskIL.DeclareLocal([IntPtr])
$taskIL.Emit([Reflection.Emit.OpCodes]::Ldc_I4,[int]0x00101000)
$taskIL.Emit([Reflection.Emit.OpCodes]::Ldc_I4_0)
$taskIL.Emit([Reflection.Emit.OpCodes]::Ldarg_0)
$taskIL.Emit([Reflection.Emit.OpCodes]::Call,[Reflection.MethodInfo]$script:taskOpenMethod)
$taskIL.Emit([Reflection.Emit.OpCodes]::Stloc_0)
$taskIL.Emit([Reflection.Emit.OpCodes]::Ldarg_1)
$taskIL.Emit([Reflection.Emit.OpCodes]::Call,[Runtime.InteropServices.Marshal].GetMethod('GetLastWin32Error'))
$taskIL.Emit([Reflection.Emit.OpCodes]::Stind_I4)
$taskIL.Emit([Reflection.Emit.OpCodes]::Ldloc_0)
$taskIL.Emit([Reflection.Emit.OpCodes]::Ret)
[void]$taskType.CreateType()
function Read-TaskExactProcess([UInt32]$taskId,[bool]$taskNeedParent){
  [int]$taskError=0
  $taskHandle=[HeadExactProcessQuery]::OpenExact($taskId,[ref]$taskError)
  if($taskHandle -eq [IntPtr]::Zero){return @{pid=[long]$taskId;state=$(if($taskError -eq 87){'gone'}else{'unknown'});errorCode=$taskError}}
  try{
    [UInt64]$taskCreated=0;[UInt64]$taskExited=0;[UInt64]$taskKernel=0;[UInt64]$taskUser=0
    if(![HeadExactProcessQuery]::GetProcessTimes($taskHandle,[ref]$taskCreated,[ref]$taskExited,[ref]$taskKernel,[ref]$taskUser)){return @{pid=[long]$taskId;state='unknown'}}
    $taskWait=[HeadExactProcessQuery]::WaitForSingleObject($taskHandle,0)
    if($taskWait -eq 0){return @{pid=[long]$taskId;state='gone'}}
    if($taskWait -ne 258){return @{pid=[long]$taskId;state='unknown'}}
    $taskParent=0
    if($taskNeedParent){
      # PROCESS_BASIC_INFORMATION: six pointer-sized fields (24/48 bytes).
      # Query the same open process handle as birth/liveness; never join by PID
      # to a second provider that can race with PID reuse or initialize WMI.
      $taskWidth=[IntPtr]::Size
      if($taskWidth -ne 4 -and $taskWidth -ne 8){return @{pid=[long]$taskId;state='unknown'}}
      $taskLength=6*$taskWidth;$taskBuffer=[Runtime.InteropServices.Marshal]::AllocHGlobal($taskLength)
      try{
        [int]$taskReturned=0
        $taskStatus=[HeadExactProcessQuery]::NtQueryInformationProcess($taskHandle,0,$taskBuffer,$taskLength,[ref]$taskReturned)
        if($taskStatus -ne 0 -or $taskReturned -ne $taskLength){return @{pid=[long]$taskId;state='unknown'}}
        $taskUnique=[Runtime.InteropServices.Marshal]::ReadIntPtr($taskBuffer,4*$taskWidth).ToInt64()
        $taskParent=[Runtime.InteropServices.Marshal]::ReadIntPtr($taskBuffer,5*$taskWidth).ToInt64()
        if($taskWidth -eq 4){$taskUnique=$taskUnique -band [long]4294967295;$taskParent=$taskParent -band [long]4294967295}
        if($taskUnique -ne $taskId -or $taskParent -lt 0 -or $taskParent -gt [UInt32]::MaxValue -or $taskParent -eq $taskId){return @{pid=[long]$taskId;state='unknown'}}
      }finally{[Runtime.InteropServices.Marshal]::FreeHGlobal($taskBuffer)}
    }
    if([HeadExactProcessQuery]::WaitForSingleObject($taskHandle,0) -ne 258){return @{pid=[long]$taskId;state='unknown'}}
    return @{pid=[long]$taskId;ppid=$taskParent;birth=('windows-filetime-'+$taskCreated.ToString([Globalization.CultureInfo]::InvariantCulture));state='present'}
  }catch{return @{pid=[long]$taskId;state='unknown'}}
  finally{[void][HeadExactProcessQuery]::CloseHandle($taskHandle)}
}
`;
